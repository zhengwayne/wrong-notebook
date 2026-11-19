import { NextResponse } from "next/server";
import { internalError, notFound } from "@/lib/api-errors";
import { getAppTimeZone } from "@/lib/config";
import { formatDateTime } from "@/lib/date-time";
import { LearnerNotFoundError } from "@/lib/learners";
import { learningScopeWhere, readRequestLearnerId, resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { getMasteryThreshold } from "@/lib/mastery";
import { PRACTICE_RECORD_COUNT, masteryStatusOf } from "@/lib/mastery-status";
import { truncatePlainPreview } from "@/lib/plain-preview";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:stats:repeated-mistakes');

/** 榜单最多列出的题目数 */
export const REPEATED_MISTAKES_LIMIT = 10;
/** 题干预览最多字数 */
const PREVIEW_LENGTH = 60;

/**
 * 反复错题榜：当前学习者做错 2 次及以上的错题，按出错次数降序取前 10。
 * 练习记录与错题都限定在同一账号、同一学习者（本人/孩子/学生）范围内。
 * Ported from margrop/wrong-notebook 07e4dca9 (MIT).
 */
export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    try {
        let scope;
        try {
            const kidLearnerId = getKidModeLearnerId();
            scope = await resolveLearningScope(prisma, user.id, kidLearnerId ?? readRequestLearnerId(req));
        } catch (error) {
            if (error instanceof LearnerNotFoundError) {
                return notFound("Learner not found");
            }
            throw error;
        }
        const scopeWhere = learningScopeWhere(scope);

        const groups = await prisma.practiceRecord.groupBy({
            by: ['errorItemId'],
            where: {
                ...scopeWhere,
                result: 'wrong',
                errorItemId: { not: null },
                // 题目本身也必须在同一作用域内，避免历史数据串到别的学习者
                errorItem: scopeWhere,
            },
            _count: { id: true },
            _max: { createdAt: true },
            having: { id: { _count: { gte: 2 } } },
            orderBy: [{ _count: { id: 'desc' } }, { _max: { createdAt: 'desc' } }],
            take: REPEATED_MISTAKES_LIMIT,
        });

        const errorItemIds = groups.map((group) => group.errorItemId).filter((id): id is string => id !== null);
        if (errorItemIds.length === 0) {
            return NextResponse.json({ items: [] });
        }

        // 只读列表需要的字段，不读图片、动画等大字段
        const [errorItems, masteryThreshold] = await Promise.all([
            prisma.errorItem.findMany({
                where: { id: { in: errorItemIds }, ...scopeWhere },
                select: {
                    id: true,
                    questionText: true,
                    masteryProbability: true,
                    subject: { select: { name: true } },
                    _count: PRACTICE_RECORD_COUNT,
                },
            }),
            getMasteryThreshold(user.id),
        ]);
        const itemById = new Map(errorItems.map((item) => [item.id, item]));
        const timeZone = getAppTimeZone();

        const items = groups.flatMap((group) => {
            const item = group.errorItemId ? itemById.get(group.errorItemId) : undefined;
            if (!item) return [];
            return [{
                id: item.id,
                subjectName: item.subject?.name ?? null,
                preview: truncatePlainPreview(item.questionText ?? '', PREVIEW_LENGTH) || null,
                wrongCount: group._count.id,
                lastWrongAt: group._max.createdAt ? formatDateTime(group._max.createdAt, 'yyyy-MM-dd', timeZone) : null,
                masteryStatus: masteryStatusOf(item._count.practiceRecords, item.masteryProbability, masteryThreshold),
            }];
        });

        return NextResponse.json({ items });
    } catch (error) {
        logger.error({ error }, 'Failed to load repeated mistakes');
        return internalError("Failed to load repeated mistakes");
    }
});
