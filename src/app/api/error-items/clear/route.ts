import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notFound, internalError } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { learningScopeWhere, readRequestLearnerId, resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:error-items:clear');

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
        // 只清除当前学习者作用域的错题，避免误删本人或其他孩子的错题
        await prisma.errorItem.deleteMany({
            where: learningScopeWhere(scope),
        });
        scheduleLearningPathReplan(userId, 'zh', scope.learnerId);

        return NextResponse.json({ message: "Error data cleared successfully" });
    } catch (error) {
        logger.error({ error }, 'Error clearing error data');
        return internalError("Failed to clear error data");
    }
});
