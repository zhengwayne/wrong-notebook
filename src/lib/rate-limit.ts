/**
 * 进程内的失败次数限流，用于登录、注册等容易被暴力尝试的入口。
 *
 * 生产环境是单个容器，计数保存在内存即可；重启后清零只会放宽限制，不会误锁用户。
 */

export interface RateLimitRule {
    /** 统计窗口内允许的最大次数 */
    limit: number;
    /** 统计窗口（毫秒），超过次数后也按这个时长锁定 */
    windowMs: number;
}

interface Bucket {
    count: number;
    resetAt: number;
}

/** 防止被大量不同的 key 撑爆内存 */
const MAX_BUCKETS = 10_000;

export class RateLimiter {
    private readonly buckets = new Map<string, Bucket>();

    constructor(private readonly rule: RateLimitRule, private readonly now: () => number = Date.now) {}

    /** 返回还需等待的毫秒数；为 0 表示未超限 */
    retryAfter(key: string): number {
        const bucket = this.current(key);
        if (!bucket || bucket.count < this.rule.limit) return 0;
        return bucket.resetAt - this.now();
    }

    /** 记一次（失败或请求），返回记完后是否已超限 */
    hit(key: string): boolean {
        const bucket = this.current(key);
        if (bucket) {
            bucket.count += 1;
            return bucket.count >= this.rule.limit;
        }
        if (this.buckets.size >= MAX_BUCKETS) this.prune();
        this.buckets.set(key, { count: 1, resetAt: this.now() + this.rule.windowMs });
        return this.rule.limit <= 1;
    }

    reset(key: string): void {
        this.buckets.delete(key);
    }

    private current(key: string): Bucket | undefined {
        const bucket = this.buckets.get(key);
        if (bucket && bucket.resetAt <= this.now()) {
            this.buckets.delete(key);
            return undefined;
        }
        return bucket;
    }

    private prune(): void {
        const now = this.now();
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= now) this.buckets.delete(key);
        }
        // 仍然太多时丢弃最早的一批，宁可放宽也不无限增长
        if (this.buckets.size >= MAX_BUCKETS) {
            const drop = Math.ceil(MAX_BUCKETS / 10);
            let i = 0;
            for (const key of this.buckets.keys()) {
                if (i++ >= drop) break;
                this.buckets.delete(key);
            }
        }
    }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined> | undefined;

function readHeader(headers: HeaderSource, name: string): string | undefined {
    if (!headers) return undefined;
    if (typeof (headers as Headers).get === "function") {
        return (headers as Headers).get(name) ?? undefined;
    }
    const record = headers as Record<string, string | string[] | undefined>;
    const lowerName = name.toLowerCase();
    const matchedKey = Object.keys(record).find((key) => key.toLowerCase() === lowerName);
    const value = matchedKey ? record[matchedKey] : undefined;
    return Array.isArray(value) ? value[0] : value;
}

export type TrustProxyMode = "false" | "true" | "cloudflare";

/** 解析当前代理信任模式：默认 false（忽略所有转发头），仅显式设为 true / cloudflare 时启用 */
export function getTrustProxyMode(env: NodeJS.ProcessEnv = process.env): TrustProxyMode {
    const raw = env.TRUST_PROXY?.trim().toLowerCase();
    if (raw === "cloudflare") return "cloudflare";
    if (raw === "true") return "true";
    return "false";
}

/** 解析可信代理跳数（默认 1，非法值回退为 1） */
export function getTrustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
    const parsed = Number.parseInt(env.TRUSTED_PROXY_HOPS || "1", 10);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function parseForwardedForHop(headerValue: string | undefined, hops: number): string | null {
    if (!headerValue) return null;
    const parts = headerValue
        .split(",")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (parts.length === 0) return null;
    const index = Math.max(0, parts.length - hops);
    return parts[index] || null;
}

/**
 * 取客户端 IP（三态 TRUST_PROXY 控制）：
 * - false / 未设置：忽略一切转发头并返回 null，避免直连暴露时伪造请求头绕过 IP 限流；
 * - true：不读取 cf-connecting-ip，按 TRUSTED_PROXY_HOPS 从 x-forwarded-for 末端回溯可信跳，缺省时回退 x-real-ip；
 * - cloudflare：优先读取 cf-connecting-ip，否则按 true 策略回退。
 */
export function getClientIp(headers: HeaderSource): string | null {
    const mode = getTrustProxyMode();
    if (mode === "false") {
        return null;
    }

    if (mode === "cloudflare") {
        const cfIp = readHeader(headers, "cf-connecting-ip")?.trim();
        if (cfIp) return cfIp;
    }

    const hops = getTrustedProxyHops();
    const xffIp = parseForwardedForHop(readHeader(headers, "x-forwarded-for"), hops);
    if (xffIp) return xffIp;

    const realIp = readHeader(headers, "x-real-ip")?.trim();
    return realIp || null;
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** 同一账号 15 分钟内密码错 5 次即锁定 15 分钟 */
export const loginAccountLimiter = new RateLimiter({ limit: 5, windowMs: FIFTEEN_MINUTES });
/** 同一 IP 15 分钟内登录失败 20 次即锁定，防止换着账号试 */
export const loginIpLimiter = new RateLimiter({ limit: 20, windowMs: FIFTEEN_MINUTES });
/** 小程序 code 换会话：每个来源 IP 15 分钟内最多 60 次 */
export const mpLoginIpLimiter = new RateLimiter({ limit: 60, windowMs: FIFTEEN_MINUTES });

/** 同一 IP 每小时最多提交 10 次注册或初始化 */
export const registerIpLimiter = new RateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

/** 每用户每分钟最多合成 60 次，给动画逐段请求留出余量 */
export const ttsUserLimiter = new RateLimiter({ limit: 60, windowMs: 60 * 1000 });

/** 每用户每分钟最多上报 60 次前端日志 */
export const frontendLogLimiter = new RateLimiter({ limit: 60, windowMs: 60 * 1000 });
