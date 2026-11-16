import { prisma } from "@/lib/prisma";
import { getAppTimeZone } from "@/lib/config";
import { getItemTags } from "@/lib/item-tags";
import { SELF_STUDENT_KEY } from "@/lib/learning-path/types";
import { getReviewPlan, isReviewDue } from "@/lib/review-schedule";

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
}) {
    const timeZone = getAppTimeZone();
    const records = await prisma.practiceRecord?.findMany?.({
        where: { errorItemId: item.id, result: { not: null } },
        select: { result: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    }) ?? [];
    const plan = getReviewPlan(item.createdAt ? new Date(item.createdAt) : new Date(), records, timeZone);

    const path = await prisma.learningPath?.findUnique?.({
        where: { userId_studentKey: { userId, studentKey: SELF_STUDENT_KEY } },
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
            where: { userId, studentKey: SELF_STUDENT_KEY, knowledgePoint: { in: points } },
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
        reviewDue: isReviewDue(plan, timeZone),
        pathSteps,
        knowledgeMastery: knowledgeMastery.map((row) => ({
            knowledgePoint: row.knowledgePoint,
            score: Math.min(1, Math.max(0, row.pKnown * row.retrievability)),
            evidenceCount: row.evidenceCount,
            dueAt: row.dueAt?.toISOString() ?? null,
        })),
    };
}
