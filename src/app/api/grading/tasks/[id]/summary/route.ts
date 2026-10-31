import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { notFound, unauthorized } from "@/lib/api-errors";
import { buildScoresCsv, summarizeTask } from "@/lib/grading";
import { toKeyQuestion } from "@/lib/grading-service";

/** GET /api/grading/tasks/:id/summary：班级汇总；?format=csv 导出成绩表 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        include: {
            questions: { orderBy: { order: 'asc' } },
            submissions: {
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true, status: true, totalScore: true, detectedName: true,
                    student: { select: { name: true } },
                    results: { select: { keyQuestionId: true, verdict: true, score: true } },
                },
            },
        },
    });
    if (!task) return notFound("Grading task not found");

    const input = {
        questions: task.questions.map(toKeyQuestion),
        submissions: task.submissions.map((submission) => ({
            id: submission.id,
            studentName: submission.student?.name || submission.detectedName,
            status: submission.status,
            totalScore: submission.totalScore,
            results: submission.results,
        })),
    };

    const url = new URL(req.url);
    if (url.searchParams.get('format') === 'csv') {
        const en = url.searchParams.get('lang') === 'en';
        const csv = buildScoresCsv(input, en ? { name: 'Name', total: 'Total' } : { name: '姓名', total: '总分' });
        return new NextResponse(csv, {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="grading-${task.id}.csv"`,
            },
        });
    }
    return NextResponse.json({ title: task.title, ...summarizeTask(input) });
}
