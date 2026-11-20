import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { getKidModeLockFromRequest } from "@/lib/kid-mode-lock";
import { unauthorized, forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { masteryStatusOf } from "@/lib/mastery-status";

const logger = createLogger('api:error-items:practice-records');

/**
 * GET /api/error-items/:id/practice-records
 * 返回错题的掌握概率与举一反三历史（按时间倒序）
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }

        const lock = getKidModeLockFromRequest(req, { userId: user.id, authVersion: user.authVersion });
        const kidScope = lock ? { learnerId: lock.learnerId } : {};
        const item = await prisma.errorItem.findUnique({
            where: { id, ...kidScope },
            select: {
                userId: true,
                masteryLevel: true,
                masteryProbability: true,
                masteryReason: true,
                masterySource: true,
                masteryEvaluatedAt: true,
                practiceRecords: {
                    where: { result: { not: null }, ...kidScope },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    select: {
                        id: true,
                        result: true,
                        difficulty: true,
                        source: true,
                        questionText: true,
                        answerText: true,
                        analysis: true,
                        wrongAnswerText: true,
                        mistakeAnalysis: true,
                        originalImageUrl: true,
                        figureSvg: true,
                        createdAt: true,
                        examQuestion: {
                            select: {
                                paperId: true,
                                order: true,
                                paper: { select: { title: true, _count: { select: { questions: { where: { order: 0 } } } } } },
                            },
                        },
                    },
                },
            },
        });

        if (!item) {
            return notFound("Item not found");
        }
        if (item.userId !== user.id) {
            return forbidden("Not authorized to access this item");
        }

        const { userId: _userId, practiceRecords, ...mastery } = item;
        return NextResponse.json({
            ...mastery,
            masteryStatus: masteryStatusOf(practiceRecords.length, mastery.masteryProbability, user.masteryThreshold),
            masteryThreshold: user.masteryThreshold,
            records: practiceRecords.map(({ examQuestion, ...record }) => ({
                ...record,
                exam: examQuestion
                    ? { paperId: examQuestion.paperId, order: examQuestion.order + Number(examQuestion.paper._count.questions > 0), title: examQuestion.paper.title }
                    : null,
            })),
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching practice records');
        return internalError("Failed to fetch practice records");
    }
}
