/**
 * 学习者：错题可以挂到具体的人。
 * - self：本人学习，默认；历史错题可以不填 learnerId
 * - student：老师花名册中的学生，studentKey 仍是 GradingStudent.id
 * - child：家长账户下的孩子，每户最多 3 个，studentKey 使用 Learner.id
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
    const count = await db.learner.count({ where: { userId, kind: LEARNER_KIND.child } });
    if (count >= MAX_CHILD_LEARNERS) throw new ChildLearnerLimitError();
    return db.learner.create({
        data: {
            userId,
            kind: LEARNER_KIND.child,
            name: name.trim(),
            order: count,
        },
    });
}


export class LearnerNotFoundError extends Error {
    constructor() {
        super('LEARNER_NOT_FOUND');
        this.name = 'LearnerNotFoundError';
    }
}

export async function updateChildLearner(db: Db, userId: string, learnerId: string, name: string): Promise<LearnerRow> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('LEARNER_NAME_REQUIRED');
    const existing = await db.learner.findFirst({
        where: { id: learnerId, userId, kind: LEARNER_KIND.child },
    });
    if (!existing) throw new LearnerNotFoundError();
    return db.learner.update({
        where: { id: existing.id },
        data: { name: trimmed },
    });
}

/**
 * 删除孩子档案。默认只删档案，错题的 learnerId 会被置空并保留。
 * 仅当 deleteQuestions 为 true 时才一并删除该孩子名下的错题（调用方必须先得到明确确认）。
 */
export async function deleteChildLearner(
    db: Db,
    userId: string,
    learnerId: string,
    options: { deleteQuestions?: boolean } = {},
): Promise<{ deletedQuestions: number }> {
    const existing = await db.learner.findFirst({
        where: { id: learnerId, userId, kind: LEARNER_KIND.child },
    });
    if (!existing) throw new LearnerNotFoundError();

    let deletedQuestions = 0;
    if (options.deleteQuestions) {
        const result = await db.errorItem.deleteMany({ where: { userId, learnerId } });
        deletedQuestions = result.count;
    } else {
        // SQLite 迁移未给 learnerId 建外键，需显式解绑，避免删档案时错题仍指向已删孩子
        await db.errorItem.updateMany({ where: { userId, learnerId }, data: { learnerId: null } });
        await db.practiceRecord.updateMany({ where: { userId, learnerId }, data: { learnerId: null } });
    }
    await db.learner.delete({ where: { id: existing.id } });
    return { deletedQuestions };
}
