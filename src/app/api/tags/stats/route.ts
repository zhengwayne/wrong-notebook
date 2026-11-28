import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound } from "@/lib/api-errors";
import { LearnerNotFoundError } from "@/lib/learners";
import { learningScopeWhere, readRequestLearnerId, resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:tags:stats');

export const dynamic = "force-dynamic";

/**
 * GET /api/tags/stats
 * 获取当前用户（或指定学习者）的标签使用频率统计
 */
export async function GET(req?: Request) {
    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }

        let scope;
        try {
            scope = await resolveLearningScope(prisma, user.id, readRequestLearnerId(req));
        } catch (error) {
            if (error instanceof LearnerNotFoundError) {
                return notFound("Learner not found");
            }
            throw error;
        }
        const scopeWhere = learningScopeWhere(scope);

        // 按标签关系统计（knowledgePoints 已弃用，只保留双写）；严格限定当前学习者作用域
        const [total, tags] = await Promise.all([
            prisma.errorItem.count({ where: scopeWhere }),
            prisma.knowledgeTag.findMany({
                where: { errorItems: { some: scopeWhere } },
                select: {
                    name: true,
                    _count: { select: { errorItems: { where: scopeWhere } } },
                },
            }),
        ]);

        // 不同学科或层级可能有同名标签，按名称合并
        const tagStats: Record<string, number> = {};
        for (const tag of tags) {
            tagStats[tag.name] = (tagStats[tag.name] || 0) + tag._count.errorItems;
        }

        // 转换为数组并按使用次数排序
        const sortedStats = Object.entries(tagStats)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);

        return NextResponse.json({
            stats: sortedStats,
            total,
            uniqueTags: sortedStats.length,
        });
    } catch (error) {
        logger.error({ error }, 'Error getting tag stats');
        return NextResponse.json(
            { message: "Failed to get tag statistics" },
            { status: 500 },
        );
    }
}
