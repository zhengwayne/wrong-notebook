import { NextResponse } from "next/server";
import { notFound } from "@/lib/api-errors";
import { buildGradingHandoutDocx } from "@/lib/docx/grading-handout-docx";
import { summarizeTask } from "@/lib/grading";
import { toKeyQuestion } from "@/lib/grading-service";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";

function safeAsciiFileName(raw: string): string {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return cleaned || "grading_handout";
}

/**
 * GET /api/grading/tasks/:id/export-docx?topN=10&answers=1
 * 按本班错题率自动生成可编辑 Word (.docx) 错题讲评讲义；默认不含参考答案，answers=1 时写入。
 */
export const GET = defineApiRoute({ auth: "user" }, async (req, { user, params }) => {
    const { id: taskId } = await (params as Promise<{ id: string }>);
    const searchParams = new URL(req.url).searchParams;
    const rawTopN = Number(searchParams.get("topN") || 10);
    const topN = Number.isFinite(rawTopN) ? Math.max(1, Math.min(50, Math.floor(rawTopN))) : 10;
    const includeAnswers = searchParams.get("answers") === "1";

    const task = await prisma.gradingTask.findFirst({
        where: { id: taskId, userId: user.id },
        select: {
            id: true,
            title: true,
            subjectName: true,
            class: { select: { name: true } },
            questions: { orderBy: { order: "asc" } },
            submissions: {
                where: { status: { in: ["graded", "confirmed"] } },
                select: {
                    id: true,
                    detectedName: true,
                    status: true,
                    totalScore: true,
                    student: { select: { name: true } },
                    results: {
                        select: {
                            keyQuestionId: true,
                            verdict: true,
                            score: true,
                            reason: true,
                            studentAnswer: true,
                        },
                    },
                },
            },
        },
    });
    if (!task) {
        return notFound("Grading task not found");
    }

    const keyQuestions = task.questions.map(toKeyQuestion);
    const summary = summarizeTask({
        questions: keyQuestions,
        submissions: task.submissions.map((sub) => ({
            id: sub.id,
            studentName: sub.student?.name || sub.detectedName || null,
            status: sub.status,
            totalScore: sub.totalScore,
            results: sub.results,
        })),
    });

    const keyById = new Map(keyQuestions.map((q) => [q.id, q]));
    const sampleReasonsByQId = new Map<string, string[]>();
    for (const sub of task.submissions) {
        for (const res of sub.results) {
            if (res.verdict === "correct") continue;
            const clippedAnswer = res.studentAnswer?.trim()
                ? Array.from(res.studentAnswer.trim()).slice(0, 40).join("")
                : "";
            const snippet = res.reason?.trim() || (clippedAnswer ? `错答示例：${clippedAnswer}` : "");
            if (!snippet) continue;
            const list = sampleReasonsByQId.get(res.keyQuestionId) || [];
            if (list.length < 3 && !list.includes(snippet)) {
                list.push(snippet);
                sampleReasonsByQId.set(res.keyQuestionId, list);
            }
        }
    }

    const docxBytes = buildGradingHandoutDocx({
        taskTitle: task.title,
        className: task.class.name,
        subjectName: task.subjectName,
        gradedCount: summary.gradedCount,
        averageScore: summary.averageScore,
        weakPoints: summary.weakPoints.map((w) => ({ name: w.name, errorRate: w.errorRate })),
        questions: summary.questions
            .filter((sq) => sq.wrong > 0)
            .map((sq) => {
                const fullQ = keyById.get(sq.id);
                return {
                    number: sq.number,
                    questionText: fullQ?.questionText ?? null,
                    answer: fullQ?.answer ?? null,
                    errorRate: sq.errorRate,
                    wrongCount: sq.wrong,
                    answeredCount: sq.answered,
                    sampleMistakes: sampleReasonsByQId.get(sq.id) || [],
                };
            }),
        topN,
        includeAnswers,
    });

    const encodedName = encodeURIComponent(`${task.title}_讲评讲义.docx`);
    const safeAscii = safeAsciiFileName(task.title);
    const asciiFallback = safeAscii === "grading_handout" ? "grading_handout.docx" : `${safeAscii}_handout.docx`;

    return new NextResponse(Buffer.from(docxBytes), {
        status: 200,
        headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
            "X-Content-Type-Options": "nosniff",
        },
    });
});
