import type { Prisma, PrismaClient } from '@prisma/client';
import { LEARNER_KIND, LearnerNotFoundError } from '@/lib/learners';
import { SELF_STUDENT_KEY } from '@/lib/learning-path/types';

type Db = PrismaClient | Prisma.TransactionClient;

/** 已校验归属的学习者作用域：null 代表本人（self），非空字符串代表未归档的学习者档案 ID */
export interface LearningScope {
    userId: string;
    learnerId: string | null;
}

/**
 * 解析并校验请求中的学习者作用域（支持本人/孩子/花名册学生）：
 * - 缺省、空白或 "self" 归一为本人作用域 { userId, learnerId: null }
 * - 非空 ID 必须在当前用户名下存在且未归档（archivedAt 为 null），否则抛出 LearnerNotFoundError
 */
export async function resolveLearningScope(
    db: Db,
    userId: string,
    rawLearnerId?: string | null,
): Promise<LearningScope> {
    const trimmed = rawLearnerId?.trim();
    if (!trimmed || trimmed === SELF_STUDENT_KEY) {
        return { userId, learnerId: null };
    }
    const learner = await db.learner.findFirst({
        where: { id: trimmed, userId, archivedAt: null },
        select: { id: true, kind: true },
    });
    if (!learner) {
        throw new LearnerNotFoundError();
    }
    if (learner.kind === LEARNER_KIND.self) {
        return { userId, learnerId: null };
    }
    return { userId, learnerId: learner.id };
}

/**
 * 解析并校验孩子作用域（仅允许本人或未归档的 child 类型档案）。
 */
export async function resolveChildLearningScope(
    db: Db,
    userId: string,
    rawLearnerId?: string | null,
): Promise<LearningScope> {
    const trimmed = rawLearnerId?.trim();
    if (!trimmed || trimmed === SELF_STUDENT_KEY) {
        return { userId, learnerId: null };
    }
    const learner = await db.learner.findFirst({
        where: { id: trimmed, userId, kind: LEARNER_KIND.child, archivedAt: null },
        select: { id: true },
    });
    if (!learner) {
        throw new LearnerNotFoundError();
    }
    return { userId, learnerId: learner.id };
}

/** 构造 ErrorItem / PracticeRecord 查询的精确作用域条件（包含 learnerId: null 本人边界） */
export function learningScopeWhere(scope: LearningScope): { userId: string; learnerId: string | null } {
    return { userId: scope.userId, learnerId: scope.learnerId };
}

/** 从请求 URL 中安全读取 learnerId 查询参数（兼容无参测试调用） */
export function readRequestLearnerId(req?: Request): string | null {
    if (!req) return null;
    return new URL(req.url).searchParams.get('learnerId');
}
