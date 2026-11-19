import { NextResponse } from "next/server";
import { z } from "zod";
import { forbidden, internalError, kidModeRestricted, notFound, validationError } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:error-items:batch-move');

/** 单次最多移动的错题数，与批量删除一致 */
export const BATCH_MOVE_LIMIT = 100;

const batchMoveSchema = z.object({
    ids: z.array(z.string().trim().min(1)).min(1).max(BATCH_MOVE_LIMIT),
    subjectId: z.string().trim().min(1),
    /** 当前查看的学习者（本人/孩子/学生）；提供时只移动该学习者的错题 */
    learnerId: z.string().trim().nullish(),
});

/**
 * POST /api/error-items/batch-move
 * 把选中的错题移动到另一个错题本。只移动当前账号（及所选学习者）的错题，目标错题本必须属于当前账号；
 * 不属于该范围的 id 计入 skipped，不会被修改。专注做题（儿童）模式下禁止。
 *
 * Ported from margrop/wrong-notebook 1c3f25cf, 52b9891d (MIT)（按本项目的学习者作用域重写）.
 */
export const POST = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    if (getKidModeLearnerId()) {
        return kidModeRestricted();
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return validationError("Invalid JSON body");
    }
    const parsed = batchMoveSchema.safeParse(body);
    if (!parsed.success) {
        return validationError("Invalid batch move request", parsed.error.issues);
    }
    const ids = [...new Set(parsed.data.ids)];
    const { subjectId } = parsed.data;

    try {
        const target = await prisma.subject.findFirst({
            where: { id: subjectId, userId: user.id },
            select: { id: true },
        });
        if (!target) {
            return forbidden("Not authorized to move to this notebook");
        }

        let learnerFilter: { learnerId: string | null } | Record<string, never> = {};
        if (parsed.data.learnerId) {
            try {
                const scope = await resolveLearningScope(prisma, user.id, parsed.data.learnerId);
                learnerFilter = { learnerId: scope.learnerId };
            } catch (error) {
                if (error instanceof LearnerNotFoundError) return notFound("Learner not found");
                throw error;
            }
        }

        const result = await prisma.errorItem.updateMany({
            where: { id: { in: ids }, userId: user.id, ...learnerFilter },
            data: { subjectId: target.id },
        });

        const skipped = ids.length - result.count;
        if (skipped > 0) {
            logger.warn({ userId: user.id, skipped }, 'Some items were outside the current scope and were not moved');
        }
        logger.info({ userId: user.id, moved: result.count, requested: ids.length }, 'Batch move completed');
        return NextResponse.json({ moved: result.count, skipped });
    } catch (error) {
        logger.error({ error }, 'Error in batch move');
        return internalError("Failed to move items");
    }
});
