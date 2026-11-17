import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { findUserByEmailInsensitive } from '@/lib/email';
import { prisma } from '@/lib/prisma';

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

/**
 * 统一解析当前 API 请求的实时数据库账户主体：
 * - 先校验 JWT Session 是否存在且绑定具体账户；
 * - 再实时查库验证用户是否存在、是否启用（isActive）及 authVersion 是否一致；
 * - 允许旧令牌（未携带 authVersion）兼容 authVersion=0 的账户，一旦用户改密/禁用使 authVersion > 0 则立即撤销。
 */
export async function resolveActor(): Promise<ResolvedActor> {
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
