import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, internalError, kidModeRestricted } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { syncItemMemory } from "@/lib/due-items";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { scheduleMasteryEvaluation } from "@/lib/mastery";
import { defineApiRoute } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:practice:record:id');

/**
 * DELETE /api/practice/record/:id
 * 删除一条举一反三记录（用于更正录错的结果），并重新评估原题掌握概率与学习路径
 */
export const DELETE = defineApiRoute<Request, { id: string }>(
    { auth: 'user' },
    async (_req, { user, params }) => {
        if (getKidModeLearnerId()) {
            return kidModeRestricted();
        }
        const { id } = await params;

        try {
            const record = await prisma.practiceRecord.findUnique({
                where: { id },
                select: { userId: true, errorItemId: true, learnerId: true },
            });
            if (!record || record.userId !== user.id) {
                return notFound("Practice record not found");
            }

            await prisma.practiceRecord.delete({ where: { id } });
            if (record.errorItemId) {
                await syncItemMemory(prisma, record.errorItemId);
                scheduleMasteryEvaluation([record.errorItemId]);
            }
            scheduleLearningPathReplan(user.id, 'zh', record.learnerId);

            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error({ error }, 'Error deleting practice record');
            return internalError("Failed to delete practice record");
        }
    },
);
