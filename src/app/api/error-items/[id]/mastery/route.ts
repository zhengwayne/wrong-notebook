import { NextResponse } from "next/server";
import { consumeAiQuota } from "@/lib/ai-quota";
import { badRequest, internalError, notFound, unauthorized } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/current-user";
import { createLogger } from "@/lib/logger";
import { evaluateErrorItemMastery } from "@/lib/mastery";
import { DEFAULT_MASTERY_THRESHOLD, masteryStatusOf } from "@/lib/mastery-status";
import { prisma } from "@/lib/prisma";

const logger = createLogger('api:error-items:mastery');

/**
 * POST /api/error-items/:id/mastery
 * 用户手动触发单道错题的 AI 掌握概率评估；录题、判重命中与练习作答不再隐式调用 AI。
 */
export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;

    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }

        const item = await prisma.errorItem.findUnique({
            where: { id },
            select: {
                id: true,
                userId: true,
                practiceRecords: {
                    where: { result: { not: null } },
                    select: { id: true },
                    take: 1,
                },
            },
        });
        if (!item || item.userId !== user.id) {
            return notFound("Item not found");
        }
        if (item.practiceRecords.length === 0) {
            return badRequest("NO_PRACTICE_HISTORY");
        }

        const limited = await consumeAiQuota(user, 'mastery');
        if (limited) return limited;

        await evaluateErrorItemMastery(id, { useAi: true });

        const updated = await prisma.errorItem.findUnique({
            where: { id },
            select: {
                masteryLevel: true,
                masteryProbability: true,
                masteryReason: true,
                masterySource: true,
                masteryEvaluatedAt: true,
                user: { select: { masteryThreshold: true } },
                _count: { select: { practiceRecords: true } },
            },
        });
        if (!updated) {
            return notFound("Item not found");
        }

        const threshold = updated.user.masteryThreshold ?? DEFAULT_MASTERY_THRESHOLD;
        return NextResponse.json({
            masteryLevel: updated.masteryLevel,
            masteryStatus: masteryStatusOf(updated._count.practiceRecords, updated.masteryProbability, threshold),
            masteryProbability: updated.masteryProbability,
            masteryReason: updated.masteryReason,
            masterySource: updated.masterySource,
            masteryEvaluatedAt: updated.masteryEvaluatedAt,
        });
    } catch (error) {
        logger.error({ error, errorItemId: id }, 'Manual AI mastery evaluation failed');
        return internalError("Failed to evaluate mastery");
    }
}
