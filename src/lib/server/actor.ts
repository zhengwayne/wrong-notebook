import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth';
import { headers } from 'next/headers';
import { authOptions } from '@/lib/auth';
import { findUserByEmailInsensitive } from '@/lib/email';
import { prisma } from '@/lib/prisma';
import { lookupMiniProgramSession, readMiniProgramBearer } from '@/lib/server/mp-auth';

/** Actor 查询的数据库字段白名单（含策略偏好与鉴权状态，显式排除 password） */
export const ACTOR_USER_SELECT = {
    id: true,
    email: true,
    name: true,
    role: true,
    isActive: true,
    authVersion: true,
    educationStage: true,
    enrollmentYear: true,
    gradeRecognitionMode: true,
    fixedGradeSemester: true,
    personas: true,
    activePersona: true,
    personasConfirmedAt: true,
    confirmBeforeImport: true,
    questionDuplicateThreshold: true,
    masteryThreshold: true,
    variantPipelineEnabled: true,
    enableGeogebra: true,
    enableSvgAnimation: true,
    themePreference: true,
    reviewAlgorithmVersion: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.UserSelect;

export type ActorUser = Prisma.UserGetPayload<{ select: typeof ACTOR_USER_SELECT }>;

export type ResolvedActor =
    | { kind: 'anonymous' }
    | { kind: 'revoked' }
    | { kind: 'disabled' }
    | { kind: 'authenticated'; user: ActorUser; session: Session };

/** 读取请求里的小程序 Bearer 令牌；没有传 req 时从 Next 请求作用域读取（脱离请求作用域时视为没有） */
async function readBearerToken(req?: Request): Promise<string | null> {
    if (req) return readMiniProgramBearer(req.headers.get('authorization'));
    try {
        const headerList = await headers();
        return readMiniProgramBearer(headerList.get('authorization'));
    } catch {
        return null;
    }
}

/**
 * 小程序 Bearer 会话：令牌摘要命中且未过期、未注销，并且签发时的 authVersion 与账户当前值一致。
 * 改密、禁用账户与网页端会话一样立即生效。
 */
async function resolveMiniProgramActor(token: string): Promise<ResolvedActor> {
    const lookup = await lookupMiniProgramSession(prisma, token);
    if (lookup.kind === 'missing') return { kind: 'anonymous' };
    if (lookup.kind === 'revoked') return { kind: 'revoked' };

    const dbUser = await prisma.user.findUnique({ where: { id: lookup.userId }, select: ACTOR_USER_SELECT });
    if (!dbUser) return { kind: 'revoked' };
    if (dbUser.isActive === false) return { kind: 'disabled' };
    const dbAuthVersion = typeof dbUser.authVersion === 'number' ? dbUser.authVersion : 0;
    if (dbAuthVersion !== lookup.authVersion) return { kind: 'revoked' };

    const session: Session = {
        user: {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            role: dbUser.role,
            isActive: true,
            authVersion: dbAuthVersion,
        },
        expires: lookup.expiresAt.toISOString(),
    };
    return { kind: 'authenticated', user: { ...dbUser, isActive: true, authVersion: dbAuthVersion }, session };
}

/**
 * 统一解析当前 API 请求的实时数据库账户主体：
 * - 带小程序 Bearer 令牌（xjmp_ 前缀）时只按令牌鉴权，不再回退 Cookie 会话；
 * - 先校验 JWT Session 是否存在且绑定具体账户；
 * - 再实时查库验证用户是否存在、是否启用（isActive）及 authVersion 是否一致；
 * - 允许旧令牌（未携带 authVersion）兼容 authVersion=0 的账户，一旦用户改密/禁用使 authVersion > 0 则立即撤销。
 */
export async function resolveActor(req?: Request): Promise<ResolvedActor> {
    const bearer = await readBearerToken(req);
    if (bearer) return resolveMiniProgramActor(bearer);

    const session = await getServerSession(authOptions);
    const sessionUser = session?.user;
    if (!sessionUser || (!sessionUser.id && !sessionUser.email)) {
        return { kind: 'anonymous' };
    }

    let dbUser: Partial<ActorUser> | null = null;
    if (sessionUser.id) {
        dbUser = await prisma.user.findUnique({
            where: { id: sessionUser.id },
            select: ACTOR_USER_SELECT,
        });
    } else if (sessionUser.email) {
        dbUser = await findUserByEmailInsensitive(prisma, sessionUser.email, ACTOR_USER_SELECT);
    }

    if (!dbUser) {
        return { kind: 'revoked' };
    }

    if (dbUser.isActive === false) {
        return { kind: 'disabled' };
    }

    const dbAuthVersion = typeof dbUser.authVersion === 'number' ? dbUser.authVersion : 0;
    const tokenAuthVersion = sessionUser.authVersion;
    const versionMismatch = tokenAuthVersion !== undefined
        ? dbAuthVersion !== tokenAuthVersion
        : dbAuthVersion > 0;
    if (versionMismatch) {
        return { kind: 'revoked' };
    }

    const hydratedUser = {
        ...dbUser,
        id: dbUser.id ?? sessionUser.id,
        email: dbUser.email ?? sessionUser.email ?? '',
        role: typeof dbUser.role === 'string' ? dbUser.role : (sessionUser.role ?? 'user'),
        isActive: true,
        authVersion: dbAuthVersion,
    } as ActorUser;

    return {
        kind: 'authenticated',
        user: hydratedUser,
        session,
    };
}
