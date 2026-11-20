import { NextResponse } from "next/server";
import { internalError, notFound } from "@/lib/api-errors";
import { getAppTimeZone } from "@/lib/config";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "@/lib/constants/pagination";
import { getDueItems } from "@/lib/due-items";
import { LearnerNotFoundError } from "@/lib/learners";
import { readRequestLearnerId, resolveLearningScope } from "@/lib/learning-scope";
import { createLogger } from "@/lib/logger";
import { getMasteryThreshold } from "@/lib/mastery";
import { PRACTICE_RECORD_COUNT, masteryStatusOf } from "@/lib/mastery-status";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";
import { getKidModeLearnerId } from "@/lib/server/request-context";

const logger = createLogger('api:review:due');

/** 今日待复习：按作答历史推算到期的错题，最早到期的排在前面 */
export const GET = defineApiRoute({ auth: 'user' }, async (req, { user }) => {
    const { searchParams } = new URL(req.url);
    const subjectId = searchParams.get("subjectId");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, parseInt(searchParams.get("pageSize") || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));

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
        const timeZone = getAppTimeZone();
        const now = new Date();
        const { items: dueEntries, algorithmVersion } = await getDueItems(prisma, scope, {
            subjectId,
            timeZone,
            date: now,
        });

        const masteryThreshold = await getMasteryThreshold(user.id);
        const pageEntries = dueEntries.slice((page - 1) * pageSize, page * pageSize);
        const items = await prisma.errorItem.findMany({
            where: { id: { in: pageEntries.map(({ id }) => id) } },
            include: {
                subject: true,
                tags: true,
                _count: PRACTICE_RECORD_COUNT,
            },
        });
        const itemById = new Map(items.map((item) => [item.id, item]));

        return NextResponse.json({
            items: pageEntries.flatMap((entry) => {
                const found = itemById.get(entry.id);
                if (!found) return [];
                const { _count, ...item } = found;
                return [{
                    ...item,
                    masteryStatus: masteryStatusOf(_count.practiceRecords, item.masteryProbability, masteryThreshold),
                    reviewStage: entry.reviewStage,
                    nextReviewAt: entry.nextReviewAt,
                }];
            }),
            total: dueEntries.length,
            page,
            pageSize,
            totalPages: Math.ceil(dueEntries.length / pageSize),
            algorithmVersion,
        });
    } catch (error) {
        logger.error({ error }, 'Failed to list due reviews');
        return internalError("Failed to list due reviews");
    }
});
