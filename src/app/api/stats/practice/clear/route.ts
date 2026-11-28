import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, internalError } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { learningScopeWhere, readRequestLearnerId, resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:stats:practice:clear');

export const DELETE = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const userId = user.id;

    try {
        let scope;
        try {
            scope = await resolveLearningScope(prisma, userId, readRequestLearnerId(req));
        } catch (error) {
            if (error instanceof LearnerNotFoundError) {
                return notFound("Learner not found");
            }
            throw error;
        }
        // 在同一事务内原子清空练习记录、FSRS 记忆状态，并重置对应作用域错题的自动掌握度评估
        const result = await prisma.$transaction(async (tx) => {
            const deleted = await tx.practiceRecord.deleteMany({
                where: learningScopeWhere(scope),
            });
            await tx.itemMemory.deleteMany({
                where: { userId, scopeKey: scope.learnerId ?? "self" },
            });
            await tx.errorItem.updateMany({
                where: learningScopeWhere(scope),
                data: {
                    masteryLevel: 0,
                    masteryProbability: null,
                    masteryReason: null,
                    masterySource: null,
                    masteryEvaluatedAt: null,
                },
            });
            return deleted;
        });

        // 异步重算该学习者的 KnowledgeMastery 与 LearningPath，保留锁定步骤、教师批注和批改证据
        scheduleLearningPathReplan(userId, "zh", scope.learnerId);

        return NextResponse.json({
            message: "Practice history cleared successfully",
            count: result.count,
        });
    } catch (error) {
        logger.error({ error }, 'Error clearing practice stats');
        return internalError("Failed to clear stats");
    }
});
