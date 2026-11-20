import crypto from 'node:crypto';
import { buildMissingReminderCopy } from '@/lib/grading-reminder-copy';
import { getClientIp } from '@/lib/rate-limit';

export { buildMissingReminderCopy };

// TODO(security): 自托管轻量部署暂不集成外部商业杀毒扫描引擎（AV API）与 CDR 宏剥离服务，通过严格限制仅接收图像重编码归一化（sharp 重新编码剥离元数据与潜在夹带载荷）保障上传安全。

const TOKEN_FORMAT_RE = /^[A-Za-z0-9_-]{24,64}$/;
export const DEFAULT_SHARE_TTL_MS = 7 * 24 * 3600 * 1000;

export function generateShareToken(): { rawToken: string; tokenHash: string } {
    const rawToken = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
    return { rawToken, tokenHash };
}

export function hashShareToken(rawToken: string | null | undefined): string {
    if (!rawToken || typeof rawToken !== 'string') return '';
    const trimmed = rawToken.trim();
    if (!TOKEN_FORMAT_RE.test(trimmed)) return '';
    return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

const rateBuckets = new Map<string, number[]>();

export function resetPublicTokenRateLimitForTests(): void {
    rateBuckets.clear();
}

export function checkPublicTokenRateLimit(
    bucketKey: string,
    limit: number,
    windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - windowMs;
    const existing = rateBuckets.get(bucketKey) ?? [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= limit) {
        rateBuckets.set(bucketKey, active);
        const oldest = active[0] ?? now;
        return {
            allowed: false,
            retryAfterMs: Math.max(1000, oldest + windowMs - now),
        };
    }

    active.push(now);
    rateBuckets.set(bucketKey, active);
    if (rateBuckets.size > 2000) {
        for (const [k, timestamps] of rateBuckets) {
            if (timestamps.every((ts) => ts <= cutoff)) {
                rateBuckets.delete(k);
            }
        }
        // 清理过期键后若仍超上限，按插入序淘汰最早桶防止随机 IP 撑爆内存
        if (rateBuckets.size > 2000) {
            for (const oldestKey of rateBuckets.keys()) {
                if (rateBuckets.size <= 2000) break;
                rateBuckets.delete(oldestKey);
            }
        }
    }
    return { allowed: true, retryAfterMs: 0 };
}

export function resolveRequestClientIp(req: Request): string {
    return (getClientIp(req.headers) || 'local').slice(0, 64);
}

const mutexGlobal = globalThis as typeof globalThis & { __wnBridgeMutexes?: Map<string, Promise<unknown>> };
const bridgeMutexes: Map<string, Promise<unknown>> = (mutexGlobal.__wnBridgeMutexes ??= new Map());

/** 按业务键串行化短链交卷与反馈卡导入临界区，防止并发双击产生重复提交或 P2002 报错 */
export async function withBridgeMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = bridgeMutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = prev.catch(() => undefined).then(() => current);
    bridgeMutexes.set(key, tail);

    await prev.catch(() => undefined);
    try {
        return await fn();
    } finally {
        release();
        if (bridgeMutexes.get(key) === tail) {
            bridgeMutexes.delete(key);
        }
    }
}
