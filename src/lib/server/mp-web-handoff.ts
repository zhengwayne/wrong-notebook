/**
 * 小程序「查看详情」→ 网页端同一账号直接打开该页面（一次性登录链接）。
 * 安全规则：
 * - 只能由有效的小程序会话（Bearer xjmp_）签发；令牌 32 字节随机数，库里只存 SHA-256 摘要；
 * - 约 5 分钟过期、只能用一次（原子地把 usedAt 从空写成当前时间，并发兑换只有一个成功）；
 * - 绑定签发账号、签发时的 authVersion、签发用的小程序会话和目标页面：改密/禁用/退出小程序/换页面都会让链接作废；
 * - 目标页面只允许站内相对路径，而且只允许错题详情、家长试卷详情两类只读查看页面；
 * - 签发时小程序处于孩子专注锁，就把同一把已签名的锁写进浏览器，网页端按同样的白名单限制，且锁定时只能签发专注模式允许的页面；
 * - 兑换只创建普通的网页会话（JWT Cookie），不设密码、不改邮箱；仅微信账号在网页端仍然不能设邮箱/密码（/api/user 照旧拒绝）。
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isKidModeAllowedPagePath, verifyKidModeToken } from '@/lib/kid-mode-lock';
import { RateLimiter } from '@/lib/rate-limit';

export const WEB_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const WEB_HANDOFF_PATH = '/api/auth/mp-handoff';
const TOKEN_PREFIX = 'xjwh_';

/** 签发限流：每个账号 10 分钟 10 次、每个 IP 10 分钟 30 次 */
export const webHandoffUserLimiter = new RateLimiter({ limit: 10, windowMs: 10 * 60 * 1000 });
export const webHandoffIpLimiter = new RateLimiter({ limit: 30, windowMs: 10 * 60 * 1000 });

/** 允许打开的目标页面：错题详情、家长试卷详情（id 只允许常见的 cuid/uuid 字符） */
const ALLOWED_TARGETS = [
    /^\/error-items\/[A-Za-z0-9_-]{1,64}$/,
    /^\/parent\/papers\/[A-Za-z0-9_-]{1,64}$/,
    // 新手引导「在电脑上做」：老师的改卷页面与使用说明
    /^\/grading$/,
    /^\/grading\/[A-Za-z0-9_-]{1,64}(\/papers)?$/,
    /^\/teacher$/,
    /^\/help$/,
];

/**
 * 只接受站内相对路径：以单个 / 开头，不能是 //host 或 /\host，不带协议、控制字符、反斜杠、.. 段，
 * 解析后仍是本站同源，再匹配允许的页面。返回规范化后的路径，否则 null。
 */
export function normalizeHandoffNext(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    // 不做 trim：前后带空白或换行的一律拒绝
    const value = raw;
    if (!value || value.length > 256) return null;
    if (!value.startsWith('/') || value.startsWith('//')) return null;
    if (/[\\\u0000-\u001f\u007f\s]/.test(value) || value.includes('..') || value.includes('%')) return null;
    let parsed: URL;
    try {
        parsed = new URL(value, 'https://handoff.invalid');
    } catch {
        return null;
    }
    if (parsed.origin !== 'https://handoff.invalid' || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== value) return null;
    return ALLOWED_TARGETS.some((pattern) => pattern.test(value)) ? value : null;
}

export function hashHandoffToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateHandoffToken(): string {
    return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function isHandoffTokenShape(token: unknown): token is string {
    return typeof token === 'string' && token.startsWith(TOKEN_PREFIX) && token.length <= 80 && /^[A-Za-z0-9_-]+$/.test(token);
}

type HandoffDb = Pick<PrismaClient, 'webHandoffToken' | 'user' | 'miniProgramSession'>;

export interface MintInput {
    userId: string;
    authVersion: number;
    mpSessionId: string;
    nextPath: string;
    /** 请求里带的已签名专注锁（未锁定为 null） */
    rawKidLock: string | null;
}

export type MintResult =
    | { ok: true; token: string; expiresAt: Date }
    | { ok: false; reason: 'BAD_TARGET' | 'KID_MODE_RESTRICTED' };

export async function mintWebHandoff(db: HandoffDb, input: MintInput, now = new Date()): Promise<MintResult> {
    const nextPath = normalizeHandoffNext(input.nextPath);
    if (!nextPath) return { ok: false, reason: 'BAD_TARGET' };
    const kid = verifyKidModeToken(input.rawKidLock, { userId: input.userId, authVersion: input.authVersion });
    if (kid && !isKidModeAllowedPagePath(nextPath)) return { ok: false, reason: 'KID_MODE_RESTRICTED' };

    // 顺手清掉这个账号过期或已用过的令牌，表不会无限增长
    await db.webHandoffToken.deleteMany({
        where: { userId: input.userId, OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
    });
    const token = generateHandoffToken();
    const expiresAt = new Date(now.getTime() + WEB_HANDOFF_TTL_MS);
    await db.webHandoffToken.create({
        data: {
            tokenHash: hashHandoffToken(token),
            userId: input.userId,
            mpSessionId: input.mpSessionId,
            nextPath,
            authVersion: input.authVersion,
            kidLock: kid ? input.rawKidLock : null,
            expiresAt,
        },
    });
    return { ok: true, token, expiresAt };
}

export function buildHandoffUrl(origin: string, token: string, nextPath: string): string {
    const url = new URL(WEB_HANDOFF_PATH, origin);
    url.searchParams.set('t', token);
    url.searchParams.set('next', nextPath);
    return url.toString();
}

export interface RedeemedHandoff {
    user: {
        id: string;
        email: string;
        name: string | null;
        role: string;
        authVersion: number;
        personas: string | null;
        activePersona: string | null;
        personasConfirmedAt: Date | null;
    };
    nextPath: string;
    kidLock: string | null;
}

export type RedeemResult = { ok: true; value: RedeemedHandoff } | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'USED' | 'MISMATCH' | 'REVOKED' };

/**
 * 校验并消费令牌。先原子地标记已用（不论后续检查是否通过，令牌都作废），再核对目标页面、账号状态、authVersion 与小程序会话。
 */
export async function redeemWebHandoff(db: HandoffDb, token: unknown, next: unknown, now = new Date()): Promise<RedeemResult> {
    if (!isHandoffTokenShape(token)) return { ok: false, reason: 'INVALID' };
    const tokenHash = hashHandoffToken(token);
    const claimed = await db.webHandoffToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
    });
    const row = await db.webHandoffToken.findUnique({ where: { tokenHash } });
    if (!row) return { ok: false, reason: 'INVALID' };
    if (claimed.count !== 1) {
        return { ok: false, reason: row.usedAt ? 'USED' : 'EXPIRED' };
    }
    if (normalizeHandoffNext(next) !== row.nextPath) return { ok: false, reason: 'MISMATCH' };

    const user = await db.user.findUnique({
        where: { id: row.userId },
        select: {
            id: true, email: true, name: true, role: true, isActive: true, authVersion: true,
            personas: true, activePersona: true, personasConfirmedAt: true,
        },
    });
    if (!user || user.isActive === false || (user.authVersion ?? 0) !== row.authVersion) return { ok: false, reason: 'REVOKED' };

    const mpSession = await db.miniProgramSession.findUnique({
        where: { id: row.mpSessionId },
        select: { userId: true, revokedAt: true, expiresAt: true, authVersion: true },
    });
    if (
        !mpSession || mpSession.userId !== user.id || mpSession.revokedAt
        || mpSession.expiresAt.getTime() <= now.getTime() || mpSession.authVersion !== row.authVersion
    ) {
        return { ok: false, reason: 'REVOKED' };
    }

    // 专注锁过期或不再匹配时不写入（与网页端校验规则相同）；仍有效则原样带到浏览器
    const kidLock = row.kidLock && verifyKidModeToken(row.kidLock, { userId: user.id, authVersion: row.authVersion }) ? row.kidLock : null;
    return {
        ok: true,
        value: {
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                authVersion: user.authVersion ?? 0,
                personas: user.personas,
                activePersona: user.activePersona,
                personasConfirmedAt: user.personasConfirmedAt,
            },
            nextPath: row.nextPath,
            kidLock,
        },
    };
}
