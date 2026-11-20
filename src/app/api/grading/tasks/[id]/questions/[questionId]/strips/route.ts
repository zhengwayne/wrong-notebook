import { NextResponse } from "next/server";
import { z } from "zod";
import { notFound, validationError } from "@/lib/api-errors";
import { applyTeacherOverride, GRADING_VERDICTS, parseJsonStringArray, totalScore } from "@/lib/grading";
import { parseStoredGradingBbox, resolveCroppedGradingItemImage, runBoundedConcurrency } from "@/lib/grading-bbox-and-pool";
import { toKeyQuestion } from "@/lib/grading-service";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";

type RouteParams = Promise<{ id: string; questionId: string }>;

const batchGradeSchema = z.object({
    updates: z.array(z.object({
        resultId: z.string().min(1),
        score: z.number().min(0).max(1000).optional(),
        verdict: z.enum(GRADING_VERDICTS).optional(),
        comment: z.string().trim().max(300).nullable().optional(),
    })).min(1).max(200),
});

/**
 * GET /api/grading/tasks/:id/questions/:questionId/strips
 * 按题号横向切题流：获取全班已识别答卷在该道题目上的作答与局部定位信息，供老师统一尺度流水连批。
 */
export const GET = defineApiRoute({ auth: "user" }, async (_req, { user, params }) => {
    const { id: taskId, questionId } = await (params as RouteParams);
    const keyQuestion = await prisma.gradingKeyQuestion.findFirst({
        where: { id: questionId, taskId, task: { userId: user.id } },
    });
    if (!keyQuestion) {
        return notFound("Question not found");
    }

    const results = await prisma.gradingResult.findMany({
        where: {
            keyQuestionId: questionId,
            submission: { taskId, status: { in: ["graded", "confirmed"] } },
        },
        include: {
            submission: {
                select: {
                    id: true,
                    status: true,
                    images: true,
                    detectedName: true,
                    student: { select: { id: true, name: true, studentNo: true } },
                },
            },
        },
        orderBy: { submission: { createdAt: "asc" } },
    });

    const strips = new Array(results.length);
    await runBoundedConcurrency(results, 2, async (res, index) => {
        const pages = parseJsonStringArray(res.submission.images);
        const bbox = parseStoredGradingBbox(res.bbox, pages.length);
        const fallbackImageUrl = bbox ? (pages[bbox.pageIndex] || pages[0] || "") : (pages[0] || "");
        const cropped = bbox ? await resolveCroppedGradingItemImage(pages, res.bbox) : null;
        const hasCroppedStrip = Boolean(cropped && cropped !== fallbackImageUrl);
        strips[index] = {
            resultId: res.id,
            submissionId: res.submission.id,
            submissionStatus: res.submission.status,
            studentName: res.submission.student?.name || res.submission.detectedName || null,
            studentNo: res.submission.student?.studentNo || null,
            studentAnswer: res.studentAnswer,
            verdict: res.verdict,
            score: res.score,
            aiScore: res.aiScore,
            reason: res.reason,
            comment: res.comment,
            bbox: hasCroppedStrip ? null : bbox,
            pageImageUrl: hasCroppedStrip ? cropped! : fallbackImageUrl,
        };
    });

    return NextResponse.json({
        question: toKeyQuestion(keyQuestion),
        strips,
    });
});

/**
 * PATCH /api/grading/tasks/:id/questions/:questionId/strips
 * 横向流水赋分或写单题批注，自动同步更新所属答卷的总分与乐观锁版本。
 */
export const PATCH = defineApiRoute({ auth: "user" }, async (req, { user, params }) => {
    const { id: taskId, questionId } = await (params as RouteParams);
    const parsed = batchGradeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return validationError("Invalid strip updates", parsed.error.issues);
    }

    const keyQuestion = await prisma.gradingKeyQuestion.findFirst({
        where: { id: questionId, taskId, task: { userId: user.id } },
        select: { id: true, maxScore: true },
    });
    if (!keyQuestion) {
        return notFound("Question not found");
    }

    const targetIds = parsed.data.updates.map((u) => u.resultId);
    const existingResults = await prisma.gradingResult.findMany({
        where: {
            id: { in: targetIds },
            keyQuestionId: questionId,
            submission: { taskId, status: "graded" },
        },
        select: { id: true, submissionId: true, score: true, verdict: true, source: true },
    });
    const resultMap = new Map(existingResults.map((r) => [r.id, r]));
    const updatesBySubmission = new Map<string, typeof parsed.data.updates>();
    for (const upd of parsed.data.updates) {
        const current = resultMap.get(upd.resultId);
        if (!current) continue;
        const list = updatesBySubmission.get(current.submissionId) || [];
        list.push(upd);
        updatesBySubmission.set(current.submissionId, list);
    }

    const touchedSubmissionIds = new Set<string>();

    await prisma.$transaction(async (tx) => {
        for (const [subId, subUpdates] of updatesBySubmission) {
            const claimed = await tx.gradingSubmission.updateMany({
                where: { id: subId, taskId, status: "graded" },
                data: { version: { increment: 1 } },
            });
            if (claimed.count === 0) continue;

            for (const upd of subUpdates) {
                const current = resultMap.get(upd.resultId)!;
                const hasScoreChange = upd.score !== undefined || upd.verdict !== undefined;
                const overridden = hasScoreChange
                    ? applyTeacherOverride(keyQuestion.maxScore, { score: upd.score, verdict: upd.verdict })
                    : null;
                await tx.gradingResult.update({
                    where: { id: current.id },
                    data: {
                        ...(overridden ?? {}),
                        ...(upd.comment !== undefined ? { comment: upd.comment } : {}),
                    },
                });
            }

            const allRes = await tx.gradingResult.findMany({
                where: { submissionId: subId },
                select: { score: true },
            });
            await tx.gradingSubmission.update({
                where: { id: subId },
                data: {
                    totalScore: totalScore(allRes),
                },
            });
            touchedSubmissionIds.add(subId);
        }
    });

    return NextResponse.json({ updatedCount: touchedSubmissionIds.size });
});
