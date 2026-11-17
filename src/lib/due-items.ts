import type { Prisma, PrismaClient } from "@prisma/client";
import { getAppTimeZone } from "@/lib/config";
import { learningScopeWhere, type LearningScope } from "@/lib/learning-scope";
import {
    DEFAULT_REVIEW_ALGORITHM,
    computeItemDuePlan,
    isItemPlanDue,
    isReviewAlgorithmVersion,
    replayItemMemory,
    type ItemMemorySnapshot,
    type ReviewAlgorithmVersion,
} from "@/lib/memory-model";

export interface DueItemEntry {
    id: string;
    reviewStage: number;
    nextReviewAt: Date;
    algorithmVersion: ReviewAlgorithmVersion;
    memory?: ItemMemorySnapshot;
}

export interface DueCandidateItem {
    id: string;
    createdAt: Date;
    practiceRecords: { result: string | null; createdAt: Date }[];
}

export interface EvaluateDueCandidatesOptions {
    date?: Date;
    algorithmVersion: ReviewAlgorithmVersion;
    timeZone: string;
}

export interface GetDueItemsOptions {
    date?: Date;
    subjectId?: string | null;
    subjectIds?: string[];
    algorithmVersion?: ReviewAlgorithmVersion;
    timeZone?: string;
}

type DbLike = PrismaClient | Prisma.TransactionClient;

/**
 * 纯函数到期判定：供 getDueItems 与学习路径服务共享同一套算法逻辑，避免两处到期列表不一致。
 */
export function evaluateDueCandidates(
    candidates: DueCandidateItem[],
    options: EvaluateDueCandidatesOptions,
): DueItemEntry[] {
    const now = options.date ?? new Date();
    const { timeZone, algorithmVersion } = options;

    return candidates
        .map((item) => {
            const plan = computeItemDuePlan(item.createdAt, item.practiceRecords, timeZone, algorithmVersion);
            return { id: item.id, plan };
        })
        .filter(({ plan }) => isItemPlanDue(plan.nextReviewAt, timeZone, now))
        .map(({ id, plan }) => ({
            id,
            reviewStage: plan.stage,
            nextReviewAt: plan.nextReviewAt!,
            algorithmVersion,
            ...(plan.memory ? { memory: plan.memory } : {}),
        }))
        .sort((a, b) => a.nextReviewAt.getTime() - b.nextReviewAt.getTime());
}

/**
 * 统一今日待复习查询：首页角标、/review 页面与学习路径共用此函数，
 * 保证不同界面与两种 algorithmVersion 下的到期题目严格一致。
 */
export async function getDueItems(
    db: DbLike,
    scope: LearningScope,
    options: GetDueItemsOptions = {},
): Promise<{ items: DueItemEntry[]; algorithmVersion: ReviewAlgorithmVersion }> {
    const timeZone = options.timeZone ?? getAppTimeZone();
    const now = options.date ?? new Date();

    let algorithmVersion = options.algorithmVersion;
    if (!algorithmVersion) {
        const userRow = await db.user?.findUnique?.({
            where: { id: scope.userId },
            select: { reviewAlgorithmVersion: true },
        });
        algorithmVersion = isReviewAlgorithmVersion(userRow?.reviewAlgorithmVersion)
            ? userRow.reviewAlgorithmVersion
            : DEFAULT_REVIEW_ALGORITHM;
    }

    const scopeWhere = learningScopeWhere(scope);
    const subjectFilter: Prisma.ErrorItemWhereInput = options.subjectId
        ? { subjectId: options.subjectId }
        : options.subjectIds && options.subjectIds.length > 0
            ? { subjectId: { in: options.subjectIds } }
            : {};

    const rawCandidates = await db.errorItem.findMany({
        where: { ...scopeWhere, ...subjectFilter },
        select: {
            id: true,
            createdAt: true,
            practiceRecords: {
                where: { learnerId: scope.learnerId },
                select: { result: true, createdAt: true },
            },
        },
    });
    const candidates = rawCandidates.map((item) => ({
        ...item,
        practiceRecords: item.practiceRecords.filter((record) => record.result !== null),
    }));

    const items = evaluateDueCandidates(candidates, { timeZone, date: now, algorithmVersion });
    return { items, algorithmVersion };
}

/** 根据 PracticeRecord 重算并持久化单道错题在作用域下的 ItemMemory 状态 */
export async function syncItemMemory(
    db: DbLike,
    errorItemId: string,
    timeZone = getAppTimeZone(),
): Promise<void> {
    if (!db?.errorItem?.findUnique || !db?.itemMemory?.upsert) return;
    const item = await db.errorItem.findUnique({
        where: { id: errorItemId },
        select: {
            id: true,
            userId: true,
            learnerId: true,
            createdAt: true,
            practiceRecords: {
                where: { result: { not: null } },
                select: { result: true, createdAt: true, learnerId: true },
            },
        },
    });
    if (!item || !item.createdAt || !Array.isArray(item.practiceRecords)) return;

    const effectiveLearnerId = item.learnerId ?? null;
    const scopeKey = effectiveLearnerId ?? "self";
    const scopedRecords = item.practiceRecords.filter((r) => (r.learnerId ?? null) === effectiveLearnerId);
    const snapshot = replayItemMemory(item.createdAt, scopedRecords, timeZone);

    await db.itemMemory.upsert({
        where: {
            userId_scopeKey_errorItemId_algorithmVersion: {
                userId: item.userId,
                scopeKey,
                errorItemId: item.id,
                algorithmVersion: snapshot.algorithmVersion,
            },
        },
        create: {
            userId: item.userId,
            learnerId: effectiveLearnerId,
            scopeKey,
            errorItemId: item.id,
            stability: snapshot.stability,
            difficulty: snapshot.difficulty,
            lastReviewAt: snapshot.lastReviewAt,
            dueAt: snapshot.dueAt,
            reps: snapshot.reps,
            lapses: snapshot.lapses,
            algorithmVersion: snapshot.algorithmVersion,
        },
        update: {
            learnerId: effectiveLearnerId,
            stability: snapshot.stability,
            difficulty: snapshot.difficulty,
            lastReviewAt: snapshot.lastReviewAt,
            dueAt: snapshot.dueAt,
            reps: snapshot.reps,
            lapses: snapshot.lapses,
        },
    });
}
