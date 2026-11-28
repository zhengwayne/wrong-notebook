import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { generateExamPaper, isPaperGenerating } from "@/lib/exam";

const logger = createLogger('api:exams:id');

/**
 * GET /api/exams/:id
 * 试卷详情，含每题内容、来源短 ID 与历次录入的结果
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

        const paper = await prisma.examPaper.findUnique({
            where: { id },
            include: {
                questions: {
                    orderBy: { order: 'asc' },
                    include: {
                        errorItem: { select: { id: true, subject: { select: { name: true } } } },
                        practiceRecords: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, result: true, createdAt: true } },
                    },
                },
            },
        });
        if (!paper || paper.userId !== user.id) {
            return notFound("Exam paper not found");
        }

        // 服务重启会中断后台生成，查看时自动续上
        if (paper.status === 'generating' && !isPaperGenerating(paper.id)) {
            void generateExamPaper(paper.id);
        }

        const { userId: _userId, questions, ...rest } = paper;
        return NextResponse.json({
            ...rest,
            questions: questions.map(({ errorItem, practiceRecords, ...question }) => ({
                ...question,
                // 旧版变式试卷从 0 编号，展示时兼容已有数据及归档恢复的旧卷。
                order: questions[0]?.order === 0 ? question.order + 1 : question.order,
                notebookName: errorItem?.subject?.name ?? null,
                attempts: practiceRecords,
            })),
        });
    } catch (error) {
        logger.error({ error }, 'Error fetching exam paper');
        return internalError("Failed to fetch exam paper");
    }
}

/**
 * DELETE /api/exams/:id
 * 删除试卷；已录入的举一反三记录保留在原题历史中
 */
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        const user = await getCurrentUser();
        if (!user) {
            return unauthorized("Authentication required");
        }

        const paper = await prisma.examPaper.findUnique({ where: { id }, select: { userId: true } });
        if (!paper || paper.userId !== user.id) {
            return notFound("Exam paper not found");
        }

        await prisma.examPaper.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (error) {
        logger.error({ error }, 'Error deleting exam paper');
        return internalError("Failed to delete exam paper");
    }
}
