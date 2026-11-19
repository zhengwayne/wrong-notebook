/**
 * 学习者：错题可以挂到具体的人。
 * - self：本人学习，默认；历史错题可以不填 learnerId
 * - student：老师花名册中的学生，studentKey 仍是 GradingStudent.id
 * - child：家长账户下的孩子，未归档最多 3 个，studentKey 使用 Learner.id
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { SELF_STUDENT_KEY } from '@/lib/learning-path/types';

export const LEARNER_KIND = {
    self: 'self',
    child: 'child',
    student: 'student',
} as const;

export type LearnerKind = (typeof LEARNER_KIND)[keyof typeof LEARNER_KIND];

export const MAX_CHILD_LEARNERS = 3;

export class ChildLearnerLimitError extends Error {
    constructor() {
        super('CHILD_LEARNER_LIMIT');
        this.name = 'ChildLearnerLimitError';
    }
}

type Db = PrismaClient | Prisma.TransactionClient;

export interface LearnerRow {
    id: string;
    userId: string;
    kind: string;
    name: string;
    gradingStudentId: string | null;
    archivedAt?: Date | null;
}

// 进程内学习者变更串行队列：防止并发创建突破未归档上限，避免多个 SQLite 写事务同时竞争锁
let learnerMutationQueue: Promise<unknown> = Promise.resolve();

function isRetryableSqliteConflict(error: unknown): boolean {
    const code = (error as { code?: string })?.code;
    const message = error instanceof Error ? error.message : String(error);
    return code === 'P2034' || code === 'P1008' || /database is locked|SQLITE_BUSY/i.test(message);
}

function isPrismaClientWithTx(db: Db): db is PrismaClient {
    return '$transaction' in db && typeof db.$transaction === 'function';
}

async function runInLearnerTx<T>(
    db: Db,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    if (!isPrismaClientWithTx(db)) {
        // 调用方已在外层事务中持有连接，直接复用避免与进程内队列形成环路死锁
        return operation(db);
    }
    const run = learnerMutationQueue.then(async () => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await db.$transaction(operation, { maxWait: 10000, timeout: 30000 });
            } catch (error) {
                if (attempt >= 2 || !isRetryableSqliteConflict(error)) throw error;
            }
        }
    });
    learnerMutationQueue = run.catch(() => undefined);
    return run;
}

/** 与学习路径、掌握模型继续兼容的 studentKey */
export function studentKeyOf(learner: Pick<LearnerRow, 'kind' | 'id' | 'gradingStudentId'>): string {
    if (learner.kind === LEARNER_KIND.self) return SELF_STUDENT_KEY;
    if (learner.kind === LEARNER_KIND.student && learner.gradingStudentId) return learner.gradingStudentId;
    return learner.id;
}

export async function ensureLearnerForGradingStudent(
    db: Db,
    params: { userId: string; gradingStudentId: string; name: string },
): Promise<LearnerRow> {
    const existing = await db.learner.findUnique({
        where: { gradingStudentId: params.gradingStudentId },
    });
    if (existing) {
        if (existing.name !== params.name) {
            return db.learner.update({
                where: { id: existing.id },
                data: { name: params.name },
            });
        }
        return existing;
    }
    return db.learner.create({
        data: {
            userId: params.userId,
            kind: LEARNER_KIND.student,
            name: params.name,
            gradingStudentId: params.gradingStudentId,
        },
    });
}

export async function createChildLearner(db: Db, userId: string, name: string): Promise<LearnerRow> {
    return runInLearnerTx(db, async (tx) => {
        // 立即升级为 SQLite 写锁，避免并发快照读到相同的未归档数量
        if (typeof (tx as { $executeRaw?: unknown }).$executeRaw === 'function') {
            await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${userId}`;
        }
        const count = await tx.learner.count({
            where: { userId, kind: LEARNER_KIND.child, archivedAt: null },
        });
        if (count >= MAX_CHILD_LEARNERS) throw new ChildLearnerLimitError();
        return tx.learner.create({
            data: {
                userId,
                kind: LEARNER_KIND.child,
                name: name.trim(),
                order: count,
            },
        });
    });
}

export class LearnerNotFoundError extends Error {
    constructor() {
        super('LEARNER_NOT_FOUND');
        this.name = 'LearnerNotFoundError';
    }
}

/** 当前用户名下未归档的孩子档案；找不到或已归档时返回 null */
export async function getOwnedChildLearner(db: Db, userId: string, learnerId: string): Promise<LearnerRow | null> {
    return db.learner.findFirst({
        where: { id: learnerId, userId, kind: LEARNER_KIND.child, archivedAt: null },
    });
}

export async function updateChildLearner(db: Db, userId: string, learnerId: string, name: string): Promise<LearnerRow> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('LEARNER_NAME_REQUIRED');
    const existing = await db.learner.findFirst({
        where: { id: learnerId, userId, kind: LEARNER_KIND.child, archivedAt: null },
    });
    if (!existing) throw new LearnerNotFoundError();
    return db.learner.update({
        where: { id: existing.id },
        data: { name: trimmed },
    });
}

/**
 * 归档或彻底删除孩子档案（单事务原子完成）：
 * - 默认仅软归档（archivedAt = now）：从孩子列表隐藏，原孩子名下的错题、练习与学习记录保持原 learnerId 不混入本人。
 * - 当 deleteQuestions 为 true 时：在同一事务内原子删除该孩子全部错题、全部练习（含无 errorItemId 练习）、家长试卷、掌握度与学习路径及档案本身。
 */
export async function deleteChildLearner(
    db: Db,
    userId: string,
    learnerId: string,
    options: { deleteQuestions?: boolean } = {},
): Promise<{ archived: boolean; deletedQuestions: number }> {
    return runInLearnerTx(db, async (tx) => {
        const existing = await tx.learner.findFirst({
            where: { id: learnerId, userId, kind: LEARNER_KIND.child, archivedAt: null },
        });
        if (!existing) throw new LearnerNotFoundError();

        if (!options.deleteQuestions) {
            await tx.learner.update({
                where: { id: existing.id },
                data: { archivedAt: new Date() },
            });
            return { archived: true, deletedQuestions: 0 };
        }

        const key = studentKeyOf(existing);
        await tx.knowledgeMastery.deleteMany({
            where: { userId, studentKey: key },
        });
        await tx.learningPathStep.deleteMany({
            where: { path: { userId, studentKey: key } },
        });
        await tx.learningPath.deleteMany({
            where: { userId, studentKey: key },
        });
        await tx.practiceRecord.deleteMany({
            where: {
                userId,
                OR: [
                    { learnerId: existing.id },
                    { errorItem: { userId, learnerId: existing.id } },
                ],
            },
        });
        await tx.parentPaper.deleteMany({
            where: { userId, learnerId: existing.id },
        });
        await tx.examPaper.deleteMany({
            where: { userId, learnerId: existing.id },
        });
        const result = await tx.errorItem.deleteMany({
            where: { userId, learnerId: existing.id },
        });
        await tx.learner.delete({ where: { id: existing.id } });
        return { archived: false, deletedQuestions: result.count };
    });
}
