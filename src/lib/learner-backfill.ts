/**
 * 把「学生名·学科」错题本里的错题挂到对应花名册学生。
 * 同名学生多于一个时不猜测，保持只属于用户；不删除任何记录。
 * 所有改动写入 LearnerBackfillAudit，可用 revertLearnerBackfill 原样撤回。
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ensureLearnerForGradingStudent } from '@/lib/learners';
import { isStudentNotebook } from '@/lib/variant/notebooks';

type Db = PrismaClient | Prisma.TransactionClient;

export interface LearnerBackfillResult {
    batchId: string;
    learnersCreated: number;
    errorItemsLinked: number;
    practiceRecordsLinked: number;
    skippedAmbiguousNames: string[];
    unmatchedNotebooks: number;
}

function isUniqueConstraint(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002';
}

export async function applyLearnerBackfill(db: Db): Promise<LearnerBackfillResult> {
    const batchId = randomUUID();
    const students = await db.gradingStudent.findMany({
        include: { class: { select: { userId: true } } },
        orderBy: { createdAt: 'asc' },
    });

    const byUser = new Map<string, { id: string; name: string }[]>();
    for (const student of students) {
        const list = byUser.get(student.class.userId) ?? [];
        list.push({ id: student.id, name: student.name.trim() });
        byUser.set(student.class.userId, list);
    }

    const skippedAmbiguousNames: string[] = [];
    let learnersCreated = 0;
    let errorItemsLinked = 0;
    let practiceRecordsLinked = 0;
    let unmatchedNotebooks = 0;

    for (const [userId, list] of byUser) {
        const nameCount = new Map<string, number>();
        for (const row of list) nameCount.set(row.name, (nameCount.get(row.name) ?? 0) + 1);

        const unique = list.filter((row) => (nameCount.get(row.name) ?? 0) === 1);
        for (const [name, count] of nameCount) {
            if (count > 1) skippedAmbiguousNames.push(`${userId}:${name}`);
        }

        const notebooks = await db.subject.findMany({
            where: { userId },
            select: { id: true, name: true },
        });

        const claimed = new Set<string>();

        for (const student of unique) {
            const before = await db.learner.findUnique({ where: { gradingStudentId: student.id } });
            const learner = await ensureLearnerForGradingStudent(db, {
                userId,
                gradingStudentId: student.id,
                name: student.name,
            });
            if (!before) {
                learnersCreated += 1;
                await db.learnerBackfillAudit.create({
                    data: { batchId, userId, entityType: 'learner', entityId: learner.id, action: 'create' },
                });
            }

            const matched = notebooks.filter((nb) => isStudentNotebook(nb.name, student.name));
            for (const notebook of matched) claimed.add(notebook.id);

            const items = await db.errorItem.findMany({
                where: { userId, subjectId: { in: matched.map((nb) => nb.id) }, learnerId: null },
                select: { id: true },
            });
            if (items.length === 0) continue;

            const itemIds = items.map((item) => item.id);
            await db.errorItem.updateMany({
                where: { id: { in: itemIds } },
                data: { learnerId: learner.id },
            });
            await db.learnerBackfillAudit.createMany({
                data: itemIds.map((entityId) => ({
                    batchId,
                    userId,
                    entityType: 'errorItem',
                    entityId,
                    action: 'link',
                    previousLearnerId: null,
                    newLearnerId: learner.id,
                })),
            });
            errorItemsLinked += itemIds.length;

            const records = await db.practiceRecord.findMany({
                where: { errorItemId: { in: itemIds }, learnerId: null },
                select: { id: true },
            });
            if (records.length === 0) continue;
            const recordIds = records.map((row) => row.id);
            await db.practiceRecord.updateMany({
                where: { id: { in: recordIds } },
                data: { learnerId: learner.id },
            });
            await db.learnerBackfillAudit.createMany({
                data: recordIds.map((entityId) => ({
                    batchId,
                    userId,
                    entityType: 'practiceRecord',
                    entityId,
                    action: 'link',
                    previousLearnerId: null,
                    newLearnerId: learner.id,
                })),
            });
            practiceRecordsLinked += recordIds.length;
        }

        unmatchedNotebooks += notebooks.filter((nb) => !claimed.has(nb.id)).length;
    }

    return {
        batchId,
        learnersCreated,
        errorItemsLinked,
        practiceRecordsLinked,
        skippedAmbiguousNames,
        unmatchedNotebooks,
    };
}

export async function revertLearnerBackfill(db: Db, batchId?: string): Promise<{
    errorItemsRestored: number;
    practiceRecordsRestored: number;
    learnersRemoved: number;
}> {
    const where = batchId ? { batchId } : {};
    const rows = await db.learnerBackfillAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
    });

    let errorItemsRestored = 0;
    let practiceRecordsRestored = 0;
    let learnersRemoved = 0;

    const links = rows.filter((row) => row.action === 'link');
    const creates = rows.filter((row) => row.action === 'create' && row.entityType === 'learner');

    for (const row of links) {
        if (row.entityType === 'errorItem') {
            const current = await db.errorItem.findUnique({ where: { id: row.entityId }, select: { learnerId: true } });
            if (!current) continue;
            // 只撤回仍停在回填结果上的行，避免覆盖之后改卷新挂上的关系
            if (row.newLearnerId && current.learnerId !== row.newLearnerId) continue;
            await db.errorItem.update({
                where: { id: row.entityId },
                data: { learnerId: row.previousLearnerId },
            });
            errorItemsRestored += 1;
        } else if (row.entityType === 'practiceRecord') {
            const current = await db.practiceRecord.findUnique({ where: { id: row.entityId }, select: { learnerId: true } });
            if (!current) continue;
            if (row.newLearnerId && current.learnerId !== row.newLearnerId) continue;
            await db.practiceRecord.update({
                where: { id: row.entityId },
                data: { learnerId: row.previousLearnerId },
            });
            practiceRecordsRestored += 1;
        }
    }

    for (const row of creates) {
        const learner = await db.learner.findUnique({
            where: { id: row.entityId },
            include: { _count: { select: { errorItems: true, practiceRecords: true } } },
        });
        if (!learner) continue;
        if (learner._count.errorItems === 0 && learner._count.practiceRecords === 0) {
            try {
                await db.learner.delete({ where: { id: learner.id } });
                learnersRemoved += 1;
            } catch (error) {
                if (!isUniqueConstraint(error)) {
                    // 可能被新的改卷流程占用
                }
            }
        }
    }

    await db.learnerBackfillAudit.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });

    return { errorItemsRestored, practiceRecordsRestored, learnersRemoved };
}
