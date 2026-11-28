/**
 * 微信小程序登录：wx.login 的 code 换 openid（code2session）；已绑定直接登录，未绑定自动建一个仅微信登录的账号，签发 Bearer 令牌。
 * - AppID / AppSecret 只从环境变量读取（WECHAT_MP_APPID / WECHAT_MP_APPSECRET），代码里不写任何密钥；
 * - 数据库只存令牌的 SHA-256 摘要；session_key 用不到，不落库也不回传；
 * - 令牌记录签发时的 authVersion，改密或禁用后立即失效，与网页端 NextAuth 会话的吊销规则一致。
 */
import crypto from 'node:crypto';
import { hash } from 'bcryptjs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { isWechatPlaceholderEmail, WECHAT_PLACEHOLDER_EMAIL_DOMAIN } from '@/lib/wechat-account';

export const MP_TOKEN_PREFIX = 'xjmp_';
export const MP_DEFAULT_SESSION_TTL_DAYS = 30;
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

/**
 * 未绑定的微信是否自动注册新账号。默认开启，且不受网页端 ALLOW_REGISTRATION 影响：
 * 微信身份已由 code2session 校验，用户只用微信即可使用；需要关闭时设 WECHAT_MP_AUTO_SIGNUP=false。
 */
export function isMiniProgramAutoSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.WECHAT_MP_AUTO_SIGNUP?.trim().toLowerCase();
    return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
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

// ---------- 仅微信登录的账号（自动注册） ----------

function openidDigest(appId: string, openid: string): string {
    return crypto.createHash('sha256').update(`${appId}:${openid}`, 'utf8').digest('hex');
}

/** 由 appId + openid 确定性生成占位邮箱：同一微信永远对应同一个邮箱，唯一索引保证并发登录只建一个账号 */
export function buildWechatPlaceholderEmail(appId: string, openid: string): string {
    return `wx_${openidDigest(appId, openid).slice(0, 24)}@${WECHAT_PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function buildWechatDefaultName(appId: string, openid: string): string {
    return `微信用户${openidDigest(appId, openid).slice(-4).toUpperCase()}`;
}

/** 随机且不公开的口令做 bcrypt：没有任何人知道明文；网页登录另外按占位邮箱直接拒绝 */
async function unusablePasswordHash(): Promise<string> {
    return hash(crypto.randomBytes(32).toString('base64url'), 10);
}

export { isWechatPlaceholderEmail };

const MP_LOGIN_USER_SELECT = {
    id: true, email: true, name: true, role: true, isActive: true, authVersion: true,
    personas: true, activePersona: true, personasConfirmedAt: true,
} satisfies Prisma.UserSelect;

export type MiniProgramLoginUser = Prisma.UserGetPayload<{ select: typeof MP_LOGIN_USER_SELECT }>;

type AccountDb = Pick<PrismaClient, 'user' | 'wechatBinding'>;

export async function findBoundMiniProgramUser(db: AccountDb, appId: string, openid: string) {
    return db.wechatBinding.findUnique({
        where: { appId_openid: { appId, openid } },
        select: { id: true, user: { select: MP_LOGIN_USER_SELECT } },
    });
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export type EnsureMiniProgramAccountResult =
    | { kind: 'existing'; bindingId: string; user: MiniProgramLoginUser }
    | { kind: 'created'; bindingId: string; user: MiniProgramLoginUser }
    | { kind: 'signup_disabled' };

/**
 * 按 openid 找到账号；没有时（允许自动注册的前提下）建一个仅微信登录的新账号并绑定，一次写入完成。
 * 并发的同一 openid：占位邮箱与 (appId, openid) 都有唯一索引，后到的写入失败后回读已建好的账号，保证只建一个。
 * 占位账号的绑定若被删除（例如管理员清理），下次登录按占位邮箱重新挂回原账号，数据不丢。
 */
export async function ensureMiniProgramAccount(
    db: AccountDb,
    input: { appId: string; openid: string; unionid?: string },
    options: { allowSignup: boolean; beforeCreate?: () => boolean },
): Promise<EnsureMiniProgramAccountResult> {
    const { appId, openid } = input;
    const placeholderEmail = buildWechatPlaceholderEmail(appId, openid);

    for (let attempt = 0; attempt < 4; attempt += 1) {
        const bound = await findBoundMiniProgramUser(db, appId, openid);
        if (bound) return { kind: 'existing', bindingId: bound.id, user: bound.user };

        // 绑定丢失但占位账号还在：重新挂回原账号
        const orphan = await db.user.findUnique({ where: { email: placeholderEmail }, select: MP_LOGIN_USER_SELECT });
        if (orphan) {
            try {
                const binding = await db.wechatBinding.create({
                    data: { appId, openid, unionid: input.unionid ?? null, userId: orphan.id },
                    select: { id: true },
                });
                return { kind: 'existing', bindingId: binding.id, user: orphan };
            } catch (error) {
                if (!isUniqueViolation(error)) throw error;
                continue;
            }
        }

        if (!options.allowSignup) return { kind: 'signup_disabled' };
        if (attempt === 0 && options.beforeCreate && !options.beforeCreate()) return { kind: 'signup_disabled' };

        try {
            const created = await db.user.create({
                data: {
                    email: placeholderEmail,
                    password: await unusablePasswordHash(),
                    name: buildWechatDefaultName(appId, openid),
                    wechatBindings: { create: { appId, openid, unionid: input.unionid ?? null } },
                },
                select: { ...MP_LOGIN_USER_SELECT, wechatBindings: { where: { appId }, select: { id: true } } },
            });
            const { wechatBindings, ...user } = created;
            return { kind: 'created', bindingId: wechatBindings[0]?.id ?? '', user };
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            // 并发请求已经建好了，回到循环开头读取
        }
    }
    throw new Error('Failed to resolve mini program account after concurrent retries');
}

/**
 * 仅微信账号里是否已有学习数据（错题、孩子、试卷、复习记录等）。
 * 有数据时不允许“关联网页账号”，避免数据被丢下或混进另一个账号。
 * 不算数据的：自学身份自动生成的“本人”学习者、打开错题本时自动建的空白默认错题本（数学 / 英语）、
 * 识别结果的临时恢复缓存（AsyncOperation）；AI 用量记录会随关联迁到网页账号。
 */
/** GET /api/notebooks 在没有错题本时自动建的默认错题本名称（空的不算用户数据） */
const AUTO_DEFAULT_NOTEBOOK_NAMES = ['数学', '英语'] as const;

export async function countWechatAccountData(
    db: PrismaClient | Prisma.TransactionClient,
    userId: string,
): Promise<{ total: number; detail: Record<string, number> }> {
    const where = { userId };
    const [
        errorItems, childLearners, parentPapers, examPapers, practiceRecords, subjects, customTags,
        gradingClasses, gradingTasks, variantRuns, knowledgeMasteries, learningPaths, dailyHomeworks,
        itemMemories, sourceImports,
    ] = await Promise.all([
        db.errorItem.count({ where }),
        db.learner.count({ where: { userId, kind: { not: 'self' } } }),
        db.parentPaper.count({ where }),
        db.examPaper.count({ where }),
        db.practiceRecord.count({ where }),
        db.subject.count({
            where: { userId, OR: [{ errorItems: { some: {} } }, { name: { notIn: [...AUTO_DEFAULT_NOTEBOOK_NAMES] } }] },
        }),
        db.knowledgeTag.count({ where }),
        db.gradingClass.count({ where }),
        db.gradingTask.count({ where }),
        db.variantRun.count({ where }),
        db.knowledgeMastery.count({ where }),
        db.learningPath.count({ where }),
        db.dailyHomeworkItem.count({ where }),
        db.itemMemory.count({ where }),
        db.sourceImport.count({ where }),
    ]);
    const detail = {
        errorItems, childLearners, parentPapers, examPapers, practiceRecords, subjects, customTags,
        gradingClasses, gradingTasks, variantRuns, knowledgeMasteries, learningPaths, dailyHomeworks,
        itemMemories, sourceImports,
    };
    return { total: Object.values(detail).reduce((sum, n) => sum + n, 0), detail };
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
    /** 仅微信登录的账号为 null（不暴露占位邮箱） */
    email: string | null;
    /** true：只用微信登录、尚未关联网页账号 */
    wechatOnly: boolean;
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
        email: isWechatPlaceholderEmail(user.email) ? null : user.email,
        wechatOnly: isWechatPlaceholderEmail(user.email),
        name: user.name,
        role: user.role,
        personas: parse(user.personas),
        activePersona: user.activePersona,
        personasConfirmed: Boolean(user.personasConfirmedAt),
    };
}
