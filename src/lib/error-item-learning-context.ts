import { prisma } from "@/lib/prisma";
import { getAppTimeZone } from "@/lib/config";
import { getItemTags } from "@/lib/item-tags";
import { SELF_STUDENT_KEY } from "@/lib/learning-path/types";
import {
    DEFAULT_REVIEW_ALGORITHM,
    computeItemDuePlan,
    isItemPlanDue,
    isReviewAlgorithmVersion,
} from "@/lib/memory-model";

export interface ErrorItemPathStepSummary {
    id: string;
    title: string;
    type: string;
    status: string;
    reason: string;
}

export async function getErrorItemLearningContext(userId: string, item: {
    id: string;
    createdAt?: Date | string | null;
    tags?: { name: string }[];
    knowledgePoints?: string | null;
    learnerId?: string | null;
}, studentKey = SELF_STUDENT_KEY) {
    const timeZone = getAppTimeZone();
    const [records, userRow] = await Promise.all([
        prisma.practiceRecord?.findMany?.({
            where: { errorItemId: item.id, learnerId: item.learnerId ?? null, result: { not: null } },
            select: { result: true, createdAt: true },
            orderBy: { createdAt: "asc" },
        }) ?? Promise.resolve([]),
        prisma.user?.findUnique?.({
            where: { id: userId },
            select: { reviewAlgorithmVersion: true },
        }) ?? Promise.resolve(null),
    ]);
    const algorithmVersion = isReviewAlgorithmVersion(userRow?.reviewAlgorithmVersion)
        ? userRow.reviewAlgorithmVersion
        : DEFAULT_REVIEW_ALGORITHM;
    const plan = computeItemDuePlan(
        item.createdAt ? new Date(item.createdAt) : new Date(),
        records,
        timeZone,
        algorithmVersion,
    );

    const path = await prisma.learningPath?.findUnique?.({
        where: { userId_studentKey: { userId, studentKey } },
        include: { steps: { orderBy: { position: "asc" } } },
    }) ?? null;
    const pathSteps: ErrorItemPathStepSummary[] = (path?.steps ?? [])
        .filter((step) => {
            try {
                const ids = JSON.parse(step.errorItemIds || "[]") as unknown;
                return Array.isArray(ids) && ids.includes(item.id);
            } catch {
                return false;
            }
        })
        .map((step) => ({
            id: step.id,
            title: step.title,
            type: step.type,
            status: step.status,
            reason: step.reason,
        }));

    const points = getItemTags(item);
    const knowledgeMastery = points.length === 0
        ? []
        : await prisma.knowledgeMastery?.findMany?.({
            where: { userId, studentKey, knowledgePoint: { in: points } },
            select: {
                knowledgePoint: true,
                pKnown: true,
                retrievability: true,
                evidenceCount: true,
                dueAt: true,
            },
        }) ?? [];

    return {
        nextReviewAt: plan.nextReviewAt?.toISOString() ?? null,
        reviewStage: plan.stage,
        reviewDue: isItemPlanDue(plan.nextReviewAt, timeZone),
        algorithmVersion,
        pathSteps,
        knowledgeMastery: knowledgeMastery.map((row) => ({
            knowledgePoint: row.knowledgePoint,
            score: Math.min(1, Math.max(0, row.pKnown * row.retrievability)),
            evidenceCount: row.evidenceCount,
            dueAt: row.dueAt?.toISOString() ?? null,
        })),
    };
}
