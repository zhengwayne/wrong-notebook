import { lookup } from 'node:dns/promises';
import { normalizeHttpBaseUrl } from '@/lib/utils';

export const OUTBOUND_FETCH_TIMEOUT_MS = 15_000;

const BLOCKED_METADATA_HOSTS = new Set([
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
]);

export class OutboundUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OutboundUrlError';
    }
}

function parseIpv4Quad(host: string): [number, number, number, number] | null {
    const parts = host.split('.');
    if (parts.length !== 4) return null;
    const nums: number[] = [];
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null;
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        nums.push(n);
    }
    return [nums[0], nums[1], nums[2], nums[3]];
}

function expandIpv6Words(raw: string): number[] | null {
    let host = raw.toLowerCase();
    const zoneIndex = host.indexOf('%');
    if (zoneIndex !== -1) {
        host = host.slice(0, zoneIndex);
    }

    // 处理末尾嵌入式 IPv4（如 ::ffff:169.254.169.254）
    const lastColon = host.lastIndexOf(':');
    if (lastColon !== -1 && host.slice(lastColon + 1).includes('.')) {
        const ipv4 = parseIpv4Quad(host.slice(lastColon + 1));
        if (!ipv4) return null;
        const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
        const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
        host = `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
    }

    const segments = host.split('::');
    if (segments.length > 2) return null;

    const parseSide = (part: string): number[] | null => {
        if (!part) return [];
        const tokens = part.split(':');
        const words: number[] = [];
        for (const token of tokens) {
            if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
            words.push(Number.parseInt(token, 16));
        }
        return words;
    };

    if (segments.length === 1) {
        const words = parseSide(segments[0]);
        return words && words.length === 8 ? words : null;
    }

    const left = parseSide(segments[0]);
    const right = parseSide(segments[1]);
    if (!left || !right || left.length + right.length >= 8) return null;
    const zeros = new Array<number>(8 - left.length - right.length).fill(0);
    return [...left, ...zeros, ...right];
}

function isBlockedIpv4([a, b, c, d]: [number, number, number, number]): boolean {
    // 未指定 / 本网络 0.0.0.0/8
    if (a === 0) return true;
    // 链路本地与 AWS/Azure/GCP 元数据 169.254.0.0/16
    if (a === 169 && b === 254) return true;
    // 阿里云实例元数据服务 100.100.100.200
    if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    return false;
}

/** 判断 IP（含 IPv4、IPv6 及 IPv4-mapped IPv6）是否落入全零或元数据链路本地禁区 */
export function isBlockedIpLiteral(rawIp: string): boolean {
    const clean = rawIp.replace(/^\[|\]$/g, '').toLowerCase();
    const ipv4 = parseIpv4Quad(clean);
    if (ipv4) {
        return isBlockedIpv4(ipv4);
    }

    const words = expandIpv6Words(clean);
    if (!words) return false;

    // 全零未指定 ::
    if (words.every((w) => w === 0)) return true;

    // 放行 IPv6 本地回环 ::1（兼容本地 Ollama / vLLM）
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return false;

    // IPv6 链路本地 fe80::/10
    if (words[0] >= 0xfe80 && words[0] <= 0xfebf) return true;

    // IPv4-mapped IPv6 ::ffff:0:0/96 或 IPv4-compatible ::a.b.c.d
    const isV4Mapped =
        words[0] === 0 && words[1] === 0 && words[2] === 0 &&
        words[3] === 0 && words[4] === 0 && (words[5] === 0xffff || words[5] === 0);
    if (isV4Mapped) {
        const mapped: [number, number, number, number] = [
            words[6] >> 8,
            words[6] & 0xff,
            words[7] >> 8,
            words[7] & 0xff,
        ];
        return isBlockedIpv4(mapped);
    }

    return false;
}

function isIpLiteral(hostname: string): boolean {
    const clean = hostname.replace(/^\[|\]$/g, '');
    return parseIpv4Quad(clean) !== null || expandIpv6Words(clean) !== null;
}

/**
 * 同步校验管理员传入的 AI/TTS 出站地址（仅允许 http/https，禁止内嵌凭据、全零地址、链路本地和云元数据地址；
 * 保留 127.0.0.1 / localhost 及 RFC1918 内网地址以兼容本地 Ollama / vLLM 等私有部署）。
 */
export function assertSafeOutboundUrl(rawUrl: string): string {
    let normalized: string;
    try {
        normalized = normalizeHttpBaseUrl(rawUrl);
    } catch (error) {
        const msg = error instanceof Error ? error.message : `Invalid base URL: ${rawUrl}`;
        throw new OutboundUrlError(msg.includes('base URL') ? msg : `Invalid base URL: ${rawUrl}`);
    }

    const parsed = new URL(normalized);
    if (parsed.username || parsed.password) {
        throw new OutboundUrlError('Blocked unsafe base URL: embedded credentials are not allowed');
    }

    const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
    if (!host) {
        throw new OutboundUrlError('Invalid base URL: missing hostname');
    }

    if (BLOCKED_METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal')) {
        throw new OutboundUrlError(`Blocked unsafe base URL host: ${host}`);
    }

    if (isBlockedIpLiteral(host)) {
        throw new OutboundUrlError(`Blocked unsafe base URL address: ${host}`);
    }

    return normalized;
}

/**
 * 异步校验出站地址（在静态校验基础上对域名解析一次，拦截指向链路本地/全零/元数据的 DNS 解析结果）。
 */
export async function resolveAndAssertSafeOutboundUrl(rawUrl: string): Promise<string> {
    const normalized = assertSafeOutboundUrl(rawUrl);
    const { hostname } = new URL(normalized);
    const cleanHost = hostname.replace(/\.+$/, '').toLowerCase();

    if (cleanHost === 'localhost' || isIpLiteral(cleanHost)) {
        return normalized;
    }

    try {
        const records = await lookup(cleanHost, { all: true });
        for (const record of records) {
            if (isBlockedIpLiteral(record.address)) {
                throw new OutboundUrlError(`Blocked unsafe base URL target: ${record.address}`);
            }
        }
    } catch (error) {
        if (error instanceof OutboundUrlError) {
            throw error;
        }
        // DNS 暂不可用或单测离线假域名时不提前阻塞，交由后续实际 fetch 处理
    }

    return normalized;
}

/** 统一受限出站 fetch：强制 15 秒超时并禁止 HTTP 重定向跳转至内网/元数据端点 */
export function fetchOutboundSafely(url: string, init: RequestInit = {}): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(url, {
        ...init,
        redirect: 'error',
        signal,
    });
}
