/**
 * 微信小程序登录：wx.login 的 code 换 openid（code2session），openid 绑定现有账号后签发 Bearer 令牌。
 * - AppID / AppSecret 只从环境变量读取（WECHAT_MP_APPID / WECHAT_MP_APPSECRET），代码里不写任何密钥；
 * - 数据库只存令牌的 SHA-256 摘要；session_key 用不到，不落库也不回传；
 * - 令牌记录签发时的 authVersion，改密或禁用后立即失效，与网页端 NextAuth 会话的吊销规则一致。
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

export const MP_TOKEN_PREFIX = 'xjmp_';
export const MP_DEFAULT_SESSION_TTL_DAYS = 30;
export const MP_BIND_TICKET_TTL_SECONDS = 10 * 60;
/** 单张图片原始体积上限，与新建错题、文件夹导入单图上限一致 */
export const MP_UPLOAD_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** multipart 额外开销（边界、表单字段） */
export const MP_UPLOAD_MAX_BODY_BYTES = MP_UPLOAD_MAX_FILE_BYTES + 1024 * 1024;
/** lastUsedAt 写回节流，避免每个请求都写库 */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface MiniProgramConfig {
    appId: string;
    appSecret: string;
}

/** 读取小程序配置；任一缺失返回 null，登录接口据此返回 503 */
export function getMiniProgramConfig(env: NodeJS.ProcessEnv = process.env): MiniProgramConfig | null {
    const appId = env.WECHAT_MP_APPID?.trim() ?? '';
    const appSecret = env.WECHAT_MP_APPSECRET?.trim() ?? '';
    if (!appId || !appSecret) return null;
    return { appId, appSecret };
}

export function getMiniProgramSessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
    const days = Number(env.WECHAT_MP_SESSION_TTL_DAYS);
    const safeDays = Number.isFinite(days) && days > 0 && days <= 365 ? days : MP_DEFAULT_SESSION_TTL_DAYS;
    return safeDays * 24 * 3600 * 1000;
}

export function hashMiniProgramToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateMiniProgramToken(): string {
    return `${MP_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

/** 从 Authorization 头里取出小程序令牌；不是本系统签发格式时返回 null，交给 NextAuth 继续处理 */
export function readMiniProgramBearer(authorization: string | null | undefined): string | null {
    if (!authorization) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    const token = match?.[1];
    if (!token || !token.startsWith(MP_TOKEN_PREFIX) || token.length > 128) return null;
    return token;
}

// ---------- code2session ----------

export interface Code2SessionResult {
    openid: string;
    unionid?: string;
}

export class WechatLoginError extends Error {
    constructor(readonly code: 'INVALID_CODE' | 'WECHAT_UNAVAILABLE', message?: string) {
        super(message ?? code);
        this.name = 'WechatLoginError';
    }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 调用微信 jscode2session；只取 openid / unionid，丢弃 session_key */
export async function code2Session(
    config: MiniProgramConfig,
    code: string,
    fetchImpl: FetchLike = fetch,
): Promise<Code2SessionResult> {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', config.appId);
    url.searchParams.set('secret', config.appSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');

    let response: Response;
    try {
        response = await fetchImpl(url.toString(), { method: 'GET', signal: AbortSignal.timeout(8000) });
    } catch {
        throw new WechatLoginError('WECHAT_UNAVAILABLE');
    }
    if (!response.ok) throw new WechatLoginError('WECHAT_UNAVAILABLE', `HTTP ${response.status}`);

    let data: { openid?: unknown; unionid?: unknown; errcode?: unknown; errmsg?: unknown };
    try {
        data = await response.json() as typeof data;
    } catch {
        throw new WechatLoginError('WECHAT_UNAVAILABLE', 'Invalid JSON');
    }
    if (typeof data.errcode === 'number' && data.errcode !== 0) {
        // 40029 code 无效、40163 code 已被使用、40226 高风险用户：都按登录凭证无效处理
        if (data.errcode === -1) throw new WechatLoginError('WECHAT_UNAVAILABLE', `errcode ${data.errcode}`);
        throw new WechatLoginError('INVALID_CODE', `errcode ${data.errcode}`);
    }
    if (typeof data.openid !== 'string' || !data.openid) {
        throw new WechatLoginError('WECHAT_UNAVAILABLE', 'Missing openid');
    }
    return {
        openid: data.openid,
        ...(typeof data.unionid === 'string' && data.unionid ? { unionid: data.unionid } : {}),
    };
}

// ---------- 绑定凭证（未绑定的 openid 用账号密码完成一次绑定） ----------

interface BindTicketPayload {
    appId: string;
    openid: string;
    unionid?: string;
    exp: number;
}

function bindTicketKey(env: NodeJS.ProcessEnv = process.env): string | null {
    const secret = env.NEXTAUTH_SECRET;
    if (secret) return `mp-bind-v1:${secret}`;
    if (env.NODE_ENV !== 'production') return `mp-bind-dev-ephemeral:${process.cwd()}`;
    return null;
}

/** 签发 10 分钟有效的绑定凭证：openid 不直接下发给前端可伪造，只放进 HMAC 签名的票据 */
export function signBindTicket(input: Omit<BindTicketPayload, 'exp'>, now = Date.now()): string {
    const key = bindTicketKey();
    if (!key) throw new Error('Missing NEXTAUTH_SECRET for mini program bind ticket');
    const payload: BindTicketPayload = { ...input, exp: Math.floor(now / 1000) + MP_BIND_TICKET_TTL_SECONDS };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${sig}`;
}

export function verifyBindTicket(ticket: string, expectedAppId: string, now = Date.now()): BindTicketPayload | null {
    const key = bindTicketKey();
    if (!key || typeof ticket !== 'string') return null;
    const parts = ticket.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [body, sig] = parts;
    const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<BindTicketPayload>;
        if (typeof parsed.appId !== 'string' || typeof parsed.openid !== 'string' || typeof parsed.exp !== 'number') return null;
        if (parsed.appId !== expectedAppId) return null;
        if (parsed.exp <= Math.floor(now / 1000)) return null;
        return {
            appId: parsed.appId,
            openid: parsed.openid,
            exp: parsed.exp,
            ...(typeof parsed.unionid === 'string' ? { unionid: parsed.unionid } : {}),
        };
    } catch {
        return null;
    }
}

// ---------- 会话 ----------

type SessionDb = Pick<PrismaClient, 'miniProgramSession'>;

export interface IssuedMiniProgramSession {
    token: string;
    expiresAt: Date;
}

export async function issueMiniProgramSession(
    db: SessionDb,
    input: { userId: string; authVersion: number; appId: string; openid: string },
    now = new Date(),
): Promise<IssuedMiniProgramSession> {
    const token = generateMiniProgramToken();
    const expiresAt = new Date(now.getTime() + getMiniProgramSessionTtlMs());
    await db.miniProgramSession.create({
        data: {
            tokenHash: hashMiniProgramToken(token),
            userId: input.userId,
            authVersion: input.authVersion,
            appId: input.appId,
            openid: input.openid,
            expiresAt,
            lastUsedAt: now,
        },
    });
    // 顺手清理该用户已过期的会话，表不会无限增长
    await db.miniProgramSession.deleteMany({ where: { userId: input.userId, expiresAt: { lt: now } } });
    return { token, expiresAt };
}

export type MiniProgramSessionLookup =
    | { kind: 'missing' }
    | { kind: 'revoked' }
    | { kind: 'ok'; sessionId: string; userId: string; authVersion: number; expiresAt: Date };

/** 按令牌摘要查会话：不存在或过期返回 missing，主动注销返回 revoked；authVersion 由调用方与用户表比对 */
export async function lookupMiniProgramSession(
    db: SessionDb,
    token: string,
    now = new Date(),
): Promise<MiniProgramSessionLookup> {
    const row = await db.miniProgramSession.findUnique({
        where: { tokenHash: hashMiniProgramToken(token) },
        select: { id: true, userId: true, authVersion: true, expiresAt: true, revokedAt: true, lastUsedAt: true },
    });
    if (!row || row.expiresAt.getTime() <= now.getTime()) return { kind: 'missing' };
    if (row.revokedAt) return { kind: 'revoked' };
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
        await db.miniProgramSession.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => undefined);
    }
    return { kind: 'ok', sessionId: row.id, userId: row.userId, authVersion: row.authVersion, expiresAt: row.expiresAt };
}

export async function revokeMiniProgramToken(db: SessionDb, token: string, now = new Date()): Promise<boolean> {
    const result = await db.miniProgramSession.updateMany({
        where: { tokenHash: hashMiniProgramToken(token), revokedAt: null },
        data: { revokedAt: now },
    });
    return result.count > 0;
}

export async function revokeUserMiniProgramSessions(db: SessionDb, userId: string, now = new Date()): Promise<number> {
    const result = await db.miniProgramSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
    });
    return result.count;
}

// ---------- 返回给小程序的账号信息 ----------

export interface MiniProgramUserProfile {
    id: string;
    email: string;
    name: string | null;
    role: string;
    personas: string[];
    activePersona: string | null;
    personasConfirmed: boolean;
}

export function toMiniProgramUserProfile(user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    personas: string;
    activePersona: string | null;
    personasConfirmedAt: Date | null;
}, parse: (raw: string) => string[]): MiniProgramUserProfile {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        personas: parse(user.personas),
        activePersona: user.activePersona,
        personasConfirmed: Boolean(user.personasConfirmedAt),
    };
}
