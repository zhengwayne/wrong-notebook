import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, notFound, internalError } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { learningScopeWhere, readRequestLearnerId, resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:clear');

export async function DELETE(req?: Request) {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
        return unauthorized();
    }

    const userId = session.user.id;

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

        return NextResponse.json({ message: "Error data cleared successfully" });
    } catch (error) {
        logger.error({ error }, 'Error clearing error data');
        return internalError("Failed to clear error data");
    }
}
