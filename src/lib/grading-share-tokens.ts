import crypto from 'node:crypto';

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
    }
    return { allowed: true, retryAfterMs: 0 };
}

export function resolveRequestClientIp(req: Request): string {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first.slice(0, 64);
    }
    return (req.headers.get('x-real-ip')?.trim() || 'local').slice(0, 64);
}

export function buildMissingReminderCopy(params: {
    taskTitle: string;
    subjectName: string;
    missingNames: string[];
    submitUrl?: string | null;
    language?: 'zh' | 'en';
}): string {
    const { taskTitle, subjectName, missingNames, submitUrl, language = 'zh' } = params;
    const count = missingNames.length;
    if (language === 'en') {
        const namesText = missingNames.join(', ');
        const linkSuffix = submitUrl ? ` Submit online here: ${submitUrl}` : '';
        return `[Homework Reminder] "${taskTitle}" (${subjectName}): ${count} student(s) still pending (${namesText}). Please assist with photo submission.${linkSuffix}`;
    }
    const namesText = missingNames.join('、');
    const linkSuffix = submitUrl ? `，在线扫码/拍照交卷入口：${submitUrl}` : '';
    return `【作业温馨提醒】《${taskTitle}》（${subjectName}）目前还有 ${count} 位同学尚未提交：${namesText}。烦请家长协助核对并提交作业${linkSuffix}，感谢配合！`;
}
