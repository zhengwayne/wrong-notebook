import { NextResponse } from "next/server";
import { z } from "zod";
import { forbidden, internalError, kidModeRestricted } from "@/lib/api-errors";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { createLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { resolveNotebookItemFilter } from "@/lib/server/notebook-item-filter";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:error-items:batch-move');

/** 单次最多移动的错题数，与批量删除一致 */
export const BATCH_MOVE_LIMIT = 100;
const BATCH_MOVE_MAX_BODY_BYTES = 64 * 1024;

const batchMoveSchema = z.object({
    ids: z.array(z.string().trim().min(1)).min(1).max(BATCH_MOVE_LIMIT),
    subjectId: z.string().trim().min(1),
    /** 当前查看的学习者（本人/孩子/学生）；提供时只移动该学习者的错题 */
    learnerId: z.string().trim().nullish(),
    /** 教师全班视角下提供班级 ID，仅移动该班级名册内学生的错题 */
    classId: z.string().trim().nullish(),
});

/**
 * POST /api/error-items/batch-move
 * 把选中的错题移动到另一个错题本。只移动当前账号（及所选学习者/班级）的错题，目标错题本必须属于当前账号；
 * 不属于该范围或已在目标错题本中的 id 计入 skipped，不会被修改。专注做题（儿童）模式下禁止。
 *
 * Ported from margrop/wrong-notebook 1c3f25cf, 52b9891d (MIT)（按本项目的学习者作用域重写）.
 */
export const POST = defineApiRoute(
    { auth: 'user', maxBodyBytes: BATCH_MOVE_MAX_BODY_BYTES, bodySchema: batchMoveSchema },
    async (_req, { user, body }) => {
        if (getKidModeLearnerId()) {
            return kidModeRestricted();
        }

        const ids = [...new Set(body.ids)];
        const { subjectId } = body;
        const requestedLearnerId = body.learnerId?.trim() || null;
        const requestedClassId = body.classId?.trim() || null;

        try {
            let scopeFilter: Record<string, unknown>;
            if (requestedLearnerId || requestedClassId) {
                const params = new URLSearchParams();
                if (requestedLearnerId) params.set('learnerId', requestedLearnerId);
                if (requestedClassId) params.set('classId', requestedClassId);
                const resolved = await resolveNotebookItemFilter(user.id, params);
                if (resolved instanceof Response) return resolved;
                scopeFilter = resolved;
            } else {
                // 未指定学习者或班级时仅允许移动本人及未归档学习者的错题，排除已归档孩子
                scopeFilter = {
                    OR: [{ learnerId: null }, { learner: { archivedAt: null } }],
                };
            }

            const outcome = await prisma.$transaction(async (tx) => {
                const target = await tx.subject.findFirst({
                    where: { id: subjectId, userId: user.id },
                    select: { id: true },
                });
                if (!target) {
                    return { forbidden: true as const };
                }

                const movable = await tx.errorItem.findMany({
                    where: {
                        id: { in: ids },
                        userId: user.id,
                        ...scopeFilter,
                        NOT: { subjectId: target.id },
                    },
                    select: { id: true, learnerId: true },
                });

                if (movable.length === 0) {
                    return { forbidden: false as const, moved: 0, learnerIds: [] as Array<string | null> };
                }

                const movableIds = movable.map((item) => item.id);
                const updated = await tx.errorItem.updateMany({
                    where: { id: { in: movableIds }, userId: user.id },
                    data: { subjectId: target.id },
                });

                const learnerIds = [...new Set(movable.map((item) => item.learnerId))];
                return { forbidden: false as const, moved: updated.count, learnerIds };
            });

            if (outcome.forbidden) {
                return forbidden("Not authorized to move to this notebook");
            }

            if (outcome.moved > 0) {
                for (const lid of outcome.learnerIds) {
                    scheduleLearningPathReplan(user.id, 'zh', lid);
                }
            }

            const skipped = ids.length - outcome.moved;
            if (skipped > 0) {
                logger.warn(
                    { userId: user.id, subjectId, learnerId: requestedLearnerId, classId: requestedClassId, skipped },
                    'Some items were outside the current scope or already in target notebook and were not moved',
                );
            }
            logger.info(
                { userId: user.id, subjectId, learnerId: requestedLearnerId, classId: requestedClassId, moved: outcome.moved, requested: ids.length },
                'Batch move completed',
            );
            return NextResponse.json({ moved: outcome.moved, skipped });
        } catch (error) {
            logger.error({ error }, 'Error in batch move');
            return internalError("Failed to move items");
        }
    },
);
