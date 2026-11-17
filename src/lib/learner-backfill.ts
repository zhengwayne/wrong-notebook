/**
 * D2 学习者历史归属治理（只读盘点 -> 歧义导出 -> 精确/唯一自动回填 -> 人工确认 -> 精确可逆撤回）：
 * - 优先级 1：通过 GradingResult -> GradingSubmission.studentId 强关联，100% 精确归属（含跨班同名学生）；
 * - 优先级 2：对同账户姓名唯一的在册学生，匹配「学生名·学科」错题本中未绑定历史错题；
 * - 跨班同名且无批改溯源链的错题不猜测，保留 learnerId=null 导出歧义清单等待人工确认；
 * - 全部变更写入 LearnerBackfillAudit，按 batchId 或仅回填动作撤回，绝不误删系统迁移 unlink_orphan 记录。
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ensureLearnerForGradingStudent, LEARNER_KIND } from '@/lib/learners';
import { isStudentNotebook } from '@/lib/variant/notebooks';

type Db = PrismaClient | Prisma.TransactionClient;

const BACKFILL_MUTATION_ACTIONS = ['create', 'link', 'manual_link'] as const;

export interface LearnerBackfillResult {
    batchId: string;
    learnersCreated: number;
    errorItemsLinked: number;
    practiceRecordsLinked: number;
    linkedByGradingResult: number;
    linkedByUniqueName: number;
    skippedAmbiguousNames: string[];
    unmatchedNotebooks: number;
}

export interface AmbiguousLearnerCandidate {
    gradingStudentId: string;
    name: string;
    studentNo: string | null;
    classId: string;
    className: string;
}

export interface AmbiguousErrorItemEntry {
    errorItemId: string;
    shortId: string | null;
    userId: string;
    subjectId: string | null;
    subjectName: string | null;
    source: string | null;
    questionPreview: string;
    createdAt: string;
    candidates: AmbiguousLearnerCandidate[];
}

export interface OrphanStudentNotebookEntry {
    subjectId: string;
    userId: string;
    subjectName: string;
    unlinkedItemCount: number;
}

export interface AmbiguousLearnerExport {
    generatedAt: string;
    ambiguousItems: AmbiguousErrorItemEntry[];
    orphanedStudentNotebooks: OrphanStudentNotebookEntry[];
}

export interface LearnerBackfillInventory {
    alreadyLinkedErrorItems: number;
    deterministicallyLinkableByGrading: number;
    deterministicallyLinkableByName: number;
    ambiguousErrorItems: number;
    orphanedStudentNotebooks: number;
    unmatchedNotebooks: number;
    skippedAmbiguousNames: string[];
}

export interface ManualLearnerDecision {
    errorItemId: string;
    target:
        | { kind: 'student'; gradingStudentId: string }
        | { kind: 'self' };
}

export interface ManualLearnerDecisionResult {
    batchId: string;
    appliedCount: number;
    practiceRecordsLinked: number;
    skippedIds: string[];
}

function isUniqueConstraint(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002';
}

interface StudentDescriptor {
    id: string;
    userId: string;
    name: string;
    studentNo: string | null;
    classId: string;
    className: string;
}

async function loadRosterByUser(db: Db) {
    const students = await db.gradingStudent.findMany({
        include: { class: { select: { id: true, name: true, userId: true } } },
        orderBy: { createdAt: 'asc' },
    });

    const byUser = new Map<string, StudentDescriptor[]>();
    const studentById = new Map<string, StudentDescriptor>();
    for (const s of students) {
        const desc: StudentDescriptor = {
            id: s.id,
            userId: s.class.userId,
            name: s.name.trim(),
            studentNo: s.studentNo,
            classId: s.class.id,
            className: s.class.name,
        };
        const list = byUser.get(desc.userId) ?? [];
        list.push(desc);
        byUser.set(desc.userId, list);
        studentById.set(desc.id, desc);
    }
    return { byUser, studentById };
}

function partitionStudentsByName(students: StudentDescriptor[]) {
    const groups = new Map<string, StudentDescriptor[]>();
    for (const student of students) {
        const list = groups.get(student.name) ?? [];
        list.push(student);
        groups.set(student.name, list);
    }
    const unique: StudentDescriptor[] = [];
    const ambiguous = new Map<string, StudentDescriptor[]>();
    for (const [name, list] of groups) {
        if (list.length === 1) unique.push(list[0]);
        else ambiguous.set(name, list);
    }
    return { unique, ambiguous };
}

async function linkErrorItemsToLearner(
    db: Db,
    params: { batchId: string; userId: string; itemIds: string[]; learnerId: string; action: 'link' | 'manual_link' },
): Promise<{ errorItemsLinked: number; practiceRecordsLinked: number }> {
    const { batchId, userId, itemIds, learnerId, action } = params;
    if (itemIds.length === 0) return { errorItemsLinked: 0, practiceRecordsLinked: 0 };

    const existingItems = await db.errorItem.findMany({
        where: { id: { in: itemIds }, userId },
        select: { id: true, learnerId: true },
    });
    const toLink = existingItems.filter((item) => item.learnerId === null || (action === 'manual_link' && item.learnerId !== learnerId));
    if (toLink.length === 0) return { errorItemsLinked: 0, practiceRecordsLinked: 0 };

    for (const item of toLink) {
        await db.errorItem.update({
            where: { id: item.id },
            data: { learnerId },
        });
        await db.learnerBackfillAudit.create({
            data: {
                batchId,
                userId,
                entityType: 'errorItem',
                entityId: item.id,
                action,
                previousLearnerId: item.learnerId,
                newLearnerId: learnerId,
            },
        });
    }

    const linkedItemIds = toLink.map((item) => item.id);
    const records = await db.practiceRecord.findMany({
        where: { errorItemId: { in: linkedItemIds }, userId, learnerId: null },
        select: { id: true },
    });
    if (records.length > 0) {
        const recordIds = records.map((r) => r.id);
        await db.practiceRecord.updateMany({
            where: { id: { in: recordIds } },
            data: { learnerId },
        });
        await db.learnerBackfillAudit.createMany({
            data: recordIds.map((entityId) => ({
                batchId,
                userId,
                entityType: 'practiceRecord',
                entityId,
                action,
                previousLearnerId: null,
                newLearnerId: learnerId,
            })),
        });
    }

    return { errorItemsLinked: linkedItemIds.length, practiceRecordsLinked: records.length };
}

/** Step 1: 只读盘点历史错题归属状况（不修改任何数据） */
export async function inventoryLearnerBackfill(db: Db): Promise<LearnerBackfillInventory> {
    const [{ byUser }, alreadyLinkedErrorItems, allNotebooks, unlinkedItems, gradingSources] = await Promise.all([
        loadRosterByUser(db),
        db.errorItem.count({ where: { learnerId: { not: null } } }),
        db.subject.findMany({ select: { id: true, userId: true, name: true } }),
        db.errorItem.findMany({
            where: { learnerId: null },
            select: { id: true, userId: true, subjectId: true },
        }),
        db.gradingResult.findMany({
            where: {
                errorItemId: { not: null },
                submission: { studentId: { not: null } },
            },
            select: { errorItemId: true, submission: { select: { studentId: true } } },
        }),
    ]);

    const deterministicByGradingItemIds = new Set<string>();
    for (const row of gradingSources) {
        if (row.errorItemId && row.submission.studentId) {
            deterministicByGradingItemIds.add(row.errorItemId);
        }
    }

    const notebooksByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const nb of allNotebooks) {
        const list = notebooksByUser.get(nb.userId) ?? [];
        list.push({ id: nb.id, name: nb.name });
        notebooksByUser.set(nb.userId, list);
    }

    const unlinkedByUserAndSubject = new Map<string, string[]>();
    for (const item of unlinkedItems) {
        if (!item.subjectId) continue;
        const key = `${item.userId}:${item.subjectId}`;
        const list = unlinkedByUserAndSubject.get(key) ?? [];
        list.push(item.id);
        unlinkedByUserAndSubject.set(key, list);
    }

    let deterministicallyLinkableByGrading = 0;
    let deterministicallyLinkableByName = 0;
    let ambiguousErrorItems = 0;
    let orphanedStudentNotebooks = 0;
    let unmatchedNotebooks = 0;
    const skippedAmbiguousNames: string[] = [];

    for (const item of unlinkedItems) {
        if (deterministicByGradingItemIds.has(item.id)) {
            deterministicallyLinkableByGrading += 1;
        }
    }

    for (const [userId, students] of byUser) {
        const { unique, ambiguous } = partitionStudentsByName(students);
        const userNotebooks = notebooksByUser.get(userId) ?? [];
        const claimed = new Set<string>();

        for (const student of unique) {
            for (const nb of userNotebooks.filter((n) => isStudentNotebook(n.name, student.name))) {
                claimed.add(nb.id);
                const ids = unlinkedByUserAndSubject.get(`${userId}:${nb.id}`) ?? [];
                deterministicallyLinkableByName += ids.filter((id) => !deterministicByGradingItemIds.has(id)).length;
            }
        }

        for (const [name] of ambiguous) {
            skippedAmbiguousNames.push(`${userId}:${name}`);
            for (const nb of userNotebooks.filter((n) => isStudentNotebook(n.name, name))) {
                claimed.add(nb.id);
                const ids = unlinkedByUserAndSubject.get(`${userId}:${nb.id}`) ?? [];
                ambiguousErrorItems += ids.filter((id) => !deterministicByGradingItemIds.has(id)).length;
            }
        }

        for (const nb of userNotebooks) {
            if (claimed.has(nb.id)) continue;
            unmatchedNotebooks += 1;
            if (nb.name.includes('·') && (unlinkedByUserAndSubject.get(`${userId}:${nb.id}`)?.length ?? 0) > 0) {
                orphanedStudentNotebooks += 1;
            }
        }
    }

    return {
        alreadyLinkedErrorItems,
        deterministicallyLinkableByGrading,
        deterministicallyLinkableByName,
        ambiguousErrorItems,
        orphanedStudentNotebooks,
        unmatchedNotebooks,
        skippedAmbiguousNames,
    };
}

/** Step 3a: 导出跨班同名歧义待确认错题清单与疑似已删学生孤立错题本（只读） */
export async function exportAmbiguousLearnerItems(db: Db): Promise<AmbiguousLearnerExport> {
    const [{ byUser }, notebooks, unlinkedItems, gradingSources] = await Promise.all([
        loadRosterByUser(db),
        db.subject.findMany({ select: { id: true, userId: true, name: true } }),
        db.errorItem.findMany({
            where: { learnerId: null },
            select: {
                id: true,
                shortId: true,
                userId: true,
                subjectId: true,
                source: true,
                questionText: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
        }),
        db.gradingResult.findMany({
            where: { errorItemId: { not: null }, submission: { studentId: { not: null } } },
            select: { errorItemId: true },
        }),
    ]);

    const deterministicIds = new Set(gradingSources.map((r) => r.errorItemId).filter((id): id is string => Boolean(id)));
    const notebookMap = new Map(notebooks.map((n) => [n.id, n]));
    const unlinkedBySubject = new Map<string, number>();
    for (const item of unlinkedItems) {
        if (item.subjectId) {
            unlinkedBySubject.set(item.subjectId, (unlinkedBySubject.get(item.subjectId) ?? 0) + 1);
        }
    }

    const ambiguousItems: AmbiguousErrorItemEntry[] = [];
    const claimedNotebookIds = new Set<string>();

    for (const [userId, students] of byUser) {
        const { unique, ambiguous } = partitionStudentsByName(students);
        const userNotebooks = notebooks.filter((n) => n.userId === userId);
        for (const s of unique) {
            userNotebooks.filter((n) => isStudentNotebook(n.name, s.name)).forEach((n) => claimedNotebookIds.add(n.id));
        }
        for (const [name, candidates] of ambiguous) {
            const matchedNotebooks = userNotebooks.filter((n) => isStudentNotebook(n.name, name));
            matchedNotebooks.forEach((n) => claimedNotebookIds.add(n.id));
            const matchedIds = new Set(matchedNotebooks.map((n) => n.id));
            for (const item of unlinkedItems) {
                if (item.userId !== userId || !item.subjectId || !matchedIds.has(item.subjectId)) continue;
                if (deterministicIds.has(item.id)) continue;
                ambiguousItems.push({
                    errorItemId: item.id,
                    shortId: item.shortId,
                    userId: item.userId,
                    subjectId: item.subjectId,
                    subjectName: notebookMap.get(item.subjectId)?.name ?? null,
                    source: item.source,
                    questionPreview: (item.questionText || '').slice(0, 120),
                    createdAt: item.createdAt.toISOString(),
                    candidates: candidates.map((c) => ({
                        gradingStudentId: c.id,
                        name: c.name,
                        studentNo: c.studentNo,
                        classId: c.classId,
                        className: c.className,
                    })),
                });
            }
        }
    }

    const orphanedStudentNotebooks: OrphanStudentNotebookEntry[] = [];
    for (const nb of notebooks) {
        if (claimedNotebookIds.has(nb.id)) continue;
        const count = unlinkedBySubject.get(nb.id) ?? 0;
        if (nb.name.includes('·') && count > 0) {
            orphanedStudentNotebooks.push({
                subjectId: nb.id,
                userId: nb.userId,
                subjectName: nb.name,
                unlinkedItemCount: count,
            });
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        ambiguousItems,
        orphanedStudentNotebooks,
    };
}

/** Step 2: 唯一可确定历史回填（为所有学生建立独立 Learner，优先按 GradingResult 溯源，再按唯一姓名匹配） */
export async function applyLearnerBackfill(db: Db): Promise<LearnerBackfillResult> {
    const batchId = randomUUID();
    const { byUser, studentById } = await loadRosterByUser(db);

    const skippedAmbiguousNames: string[] = [];
    let learnersCreated = 0;
    let errorItemsLinked = 0;
    let practiceRecordsLinked = 0;
    let linkedByGradingResult = 0;
    let linkedByUniqueName = 0;
    let unmatchedNotebooks = 0;

    // 1. 先为全部花名册学生（含同名学生）创建独立 Learner，避免按 learnerId 查询时查无此人
    const learnerIdByStudentId = new Map<string, string>();
    for (const [userId, students] of byUser) {
        for (const student of students) {
            const before = await db.learner.findUnique({ where: { gradingStudentId: student.id } });
            const learner = await ensureLearnerForGradingStudent(db, {
                userId,
                gradingStudentId: student.id,
                name: student.name,
            });
            learnerIdByStudentId.set(student.id, learner.id);
            if (!before) {
                learnersCreated += 1;
                await db.learnerBackfillAudit.create({
                    data: { batchId, userId, entityType: 'learner', entityId: learner.id, action: 'create' },
                });
            }
        }
    }

    // 2. 第一优先级：利用 GradingResult -> GradingSubmission.studentId 100% 确定回填（跨班同名同样精确归位）
    const gradingLinks = await db.gradingResult.findMany({
        where: {
            errorItemId: { not: null },
            submission: { studentId: { not: null } },
        },
        select: {
            errorItemId: true,
            submission: { select: { studentId: true } },
        },
    });
    const itemIdsByStudent = new Map<string, string[]>();
    for (const row of gradingLinks) {
        const stuId = row.submission.studentId;
        const itemId = row.errorItemId;
        if (!stuId || !itemId || !learnerIdByStudentId.has(stuId)) continue;
        const list = itemIdsByStudent.get(stuId) ?? [];
        if (!list.includes(itemId)) list.push(itemId);
        itemIdsByStudent.set(stuId, list);
    }
    for (const [stuId, itemIds] of itemIdsByStudent) {
        const student = studentById.get(stuId);
        const learnerId = learnerIdByStudentId.get(stuId);
        if (!student || !learnerId) continue;
        const linked = await linkErrorItemsToLearner(db, {
            batchId,
            userId: student.userId,
            itemIds,
            learnerId,
            action: 'link',
        });
        errorItemsLinked += linked.errorItemsLinked;
        practiceRecordsLinked += linked.practiceRecordsLinked;
        linkedByGradingResult += linked.errorItemsLinked;
    }

    // 3. 第二优先级：同账号唯一姓名的剩余历史错题本未绑定错题回填
    for (const [userId, list] of byUser) {
        const { unique, ambiguous } = partitionStudentsByName(list);
        for (const [name] of ambiguous) {
            skippedAmbiguousNames.push(`${userId}:${name}`);
        }

        const notebooks = await db.subject.findMany({
            where: { userId },
            select: { id: true, name: true },
        });
        const claimed = new Set<string>();

        for (const student of unique) {
            const learnerId = learnerIdByStudentId.get(student.id);
            if (!learnerId) continue;

            const matched = notebooks.filter((nb) => isStudentNotebook(nb.name, student.name));
            for (const notebook of matched) claimed.add(notebook.id);

            const items = await db.errorItem.findMany({
                where: { userId, subjectId: { in: matched.map((nb) => nb.id) }, learnerId: null },
                select: { id: true },
            });
            const linked = await linkErrorItemsToLearner(db, {
                batchId,
                userId,
                itemIds: items.map((item) => item.id),
                learnerId,
                action: 'link',
            });
            errorItemsLinked += linked.errorItemsLinked;
            practiceRecordsLinked += linked.practiceRecordsLinked;
            linkedByUniqueName += linked.errorItemsLinked;
        }

        unmatchedNotebooks += notebooks.filter((nb) => !claimed.has(nb.id)).length;
    }

    return {
        batchId,
        learnersCreated,
        errorItemsLinked,
        practiceRecordsLinked,
        linkedByGradingResult,
        linkedByUniqueName,
        skippedAmbiguousNames,
        unmatchedNotebooks,
    };
}

/** Step 3b: 按人工确认结果指派歧义错题并写入 manual_link 审计日志（可按 batchId 回滚） */
export async function applyManualLearnerDecisions(
    db: Db,
    decisions: ManualLearnerDecision[],
): Promise<ManualLearnerDecisionResult> {
    const batchId = randomUUID();
    let appliedCount = 0;
    let practiceRecordsLinked = 0;
    const skippedIds: string[] = [];

    for (const decision of decisions) {
        const item = await db.errorItem.findUnique({
            where: { id: decision.errorItemId },
            select: { id: true, userId: true },
        });
        if (!item) {
            skippedIds.push(decision.errorItemId);
            continue;
        }

        let targetLearnerId: string | null = null;
        if (decision.target.kind === 'student') {
            const student = await db.gradingStudent.findFirst({
                where: { id: decision.target.gradingStudentId, class: { userId: item.userId } },
                select: { id: true, name: true },
            });
            if (!student) {
                skippedIds.push(decision.errorItemId);
                continue;
            }
            const learner = await ensureLearnerForGradingStudent(db, {
                userId: item.userId,
                gradingStudentId: student.id,
                name: student.name,
            });
            targetLearnerId = learner.id;
        } else {
            const existingSelf = await db.learner.findFirst({
                where: { userId: item.userId, kind: LEARNER_KIND.self },
                select: { id: true },
            });
            const selfLearner = existingSelf ?? await db.learner.create({
                data: { userId: item.userId, kind: LEARNER_KIND.self, name: '本人', order: 0 },
                select: { id: true },
            });
            targetLearnerId = selfLearner.id;
        }

        const linked = await linkErrorItemsToLearner(db, {
            batchId,
            userId: item.userId,
            itemIds: [item.id],
            learnerId: targetLearnerId,
            action: 'manual_link',
        });
        if (linked.errorItemsLinked > 0) {
            appliedCount += linked.errorItemsLinked;
            practiceRecordsLinked += linked.practiceRecordsLinked;
        } else {
            skippedIds.push(decision.errorItemId);
        }
    }

    return { batchId, appliedCount, practiceRecordsLinked, skippedIds };
}

const BACKFILL_MARKER = {
    entityType: 'system',
    entityId: 'learner-backfill-v2',
    action: 'complete',
} as const;

/** 幂等执行学习者历史回填：已完成过一次且未撤回时直接跳过，避免冷启动重复扫表 */
export async function ensureLearnerBackfillOnce(db: Db): Promise<LearnerBackfillResult | null> {
    const marker = await db.learnerBackfillAudit.findFirst({
        where: BACKFILL_MARKER,
        select: { id: true },
    });
    if (marker) {
        return null;
    }

    const result = await applyLearnerBackfill(db);
    await db.learnerBackfillAudit.create({
        data: {
            batchId: result.batchId,
            userId: 'system',
            ...BACKFILL_MARKER,
        },
    });
    return result;
}

/** Step 4: 精确可逆撤回回填与人工确认记录，严禁触碰外键迁移生成的 unlink_orphan 审计行 */
export async function revertLearnerBackfill(db: Db, batchId?: string): Promise<{
    errorItemsRestored: number;
    practiceRecordsRestored: number;
    learnersRemoved: number;
}> {
    const where: Prisma.LearnerBackfillAuditWhereInput = batchId
        ? {
            batchId,
            NOT: { action: 'unlink_orphan' },
        }
        : {
            OR: [
                { action: { in: [...BACKFILL_MUTATION_ACTIONS] } },
                { entityType: 'system', entityId: { startsWith: 'learner-backfill-' }, action: 'complete' },
            ],
        };
    const rows = await db.learnerBackfillAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
    });

    let errorItemsRestored = 0;
    let practiceRecordsRestored = 0;
    let learnersRemoved = 0;

    const links = rows.filter((row) => row.action === 'link' || row.action === 'manual_link');
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

    if (rows.length > 0) {
        await db.learnerBackfillAudit.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    }

    return { errorItemsRestored, practiceRecordsRestored, learnersRemoved };
}
