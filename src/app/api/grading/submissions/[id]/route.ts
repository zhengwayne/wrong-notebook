import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, conflict, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { applyTeacherOverride, parseJsonStringArray, totalScore } from "@/lib/grading";
import { taskClassIds, toKeyQuestion } from "@/lib/grading-service";
import { resultOverrideBaseSchema } from "@/lib/grading-api";
import { parseCandidates, parseMatchReason } from "@/lib/grading-match-json";
import { computeSubmissionBucket } from "@/lib/grading-triage";
import { PROCESS_CAPSULE_KEYS } from "@/lib/process-evaluation";

import { PROCESS_LEVELS } from "@/lib/ai/exam-paper-read";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
    studentId: z.string().min(1).nullable().optional(),
    handwritingLevel: z.enum(PROCESS_LEVELS).nullable().optional(),
    neatnessLevel: z.enum(PROCESS_LEVELS).nullable().optional(),
    attitudeLevel: z.enum(PROCESS_LEVELS).nullable().optional(),
    processTags: z.array(z.enum(PROCESS_CAPSULE_KEYS)).max(12).optional(),
    teacherComment: z.string().trim().max(500).nullable().optional(),
    results: z.array(resultOverrideBaseSchema.extend({
        comment: z.string().trim().max(300).nullable().optional(),
    }).refine(
        (value) => value.verdict !== undefined || value.score !== undefined || value.comment !== undefined,
    )).max(200).optional(),
});

async function loadOwned(id: string, userId: string) {
    return prisma.gradingSubmission.findFirst({
        where: { id, task: { userId } },
        include: {
            task: { select: { id: true, classId: true, extraClassIds: true, userId: true, title: true, scoringMode: true } },
            student: { select: { id: true, name: true } },
            results: { include: { keyQuestion: true }, orderBy: { keyQuestion: { order: 'asc' } } },
        },
    });
}

function serialize(submission: NonNullable<Awaited<ReturnType<typeof loadOwned>>>) {
    return {
        id: submission.id,
        taskId: submission.task.id,
        taskTitle: submission.task.title,
        scoringMode: submission.task.scoringMode,
        studentId: submission.studentId,
        studentName: submission.student?.name || null,
        detectedName: submission.detectedName,
        detectedClass: submission.detectedClass,
        detectedStudentNo: submission.detectedStudentNo,
        matchStatus: submission.matchStatus,
        matchConfidence: submission.matchConfidence,
        matchReason: parseMatchReason(submission.matchReason),
        matchCandidates: parseCandidates(submission.matchCandidates),
        status: submission.status,
        reviewBucket: submission.reviewBucket,
        handwritingLevel: submission.handwritingLevel,
        neatnessLevel: submission.neatnessLevel,
        attitudeLevel: submission.attitudeLevel,
        processTags: parseJsonStringArray(submission.processTags),
        visualAlerts: parseJsonStringArray(submission.visualAlerts),
        teacherComment: submission.teacherComment,
        version: submission.version ?? 0,
        totalScore: submission.totalScore,
        error: submission.error,
        importedCount: submission.importedCount,
        images: parseJsonStringArray(submission.images),
        results: submission.results.map(({ keyQuestion, ...result }) => ({ ...result, question: toKeyQuestion(keyQuestion) })),
    };
}

/** GET /api/grading/submissions/:id：答卷图片与逐题判分 */
export async function GET(_req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const submission = await loadOwned(id, user.id);
    if (!submission) return notFound("Submission not found");
    return NextResponse.json(serialize(submission));
}

/** PATCH /api/grading/submissions/:id：指定学生、老师改判（一键对/错或给分），CAS 抢占后重算总分与红绿灯 */
export async function PATCH(req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid submission update", parsed.error.issues);

    const txResult = await prisma.$transaction(async (tx) => {
        const current = await tx.gradingSubmission.findFirst({
            where: { id, task: { userId: user.id } },
            include: {
                task: { select: { id: true, classId: true, extraClassIds: true } },
                results: { include: { keyQuestion: true } },
            },
        });
        if (!current) return "NOT_FOUND" as const;
        if (current.status === "confirmed" || current.status === "grading") {
            return "LOCKED" as const;
        }
        if (parsed.data.studentId) {
            const student = await tx.gradingStudent.findFirst({
                where: { id: parsed.data.studentId, classId: { in: taskClassIds(current.task) } },
                select: { id: true },
            });
            if (!student) return "INVALID_STUDENT" as const;
        }

        const claimed = await tx.gradingSubmission.updateMany({
            where: { id, version: current.version, status: { notIn: ["confirmed", "grading"] } },
            data: { version: { increment: 1 } },
        });
        if (claimed.count === 0) return "LOCKED" as const;

        const byId = new Map(current.results.map((result) => [result.id, result]));
        const nextResults = new Map(
            current.results.map((result) => [
                result.id,
                {
                    score: result.score,
                    verdict: result.verdict,
                    type: result.keyQuestion.type,
                    confidence: result.confidence,
                    answerSource: result.keyQuestion.answerSource,
                },
            ]),
        );

        let updatedResultCount = 0;
        for (const override of parsed.data.results || []) {
            const existing = byId.get(override.id);
            if (!existing) continue;
            const hasScoreOrVerdict = override.score !== undefined || override.verdict !== undefined;
            const next = hasScoreOrVerdict
                ? applyTeacherOverride(existing.keyQuestion.maxScore, override)
                : { score: existing.score, verdict: existing.verdict, source: existing.source };
            await tx.gradingResult.update({
                where: { id: existing.id },
                data: {
                    ...(hasScoreOrVerdict ? next : {}),
                    ...(override.comment !== undefined ? { comment: override.comment } : {}),
                },
            });
            updatedResultCount += 1;
            const snapshot = nextResults.get(existing.id)!;
            nextResults.set(existing.id, {
                ...snapshot,
                score: next.score,
                verdict: next.verdict,
                confidence: hasScoreOrVerdict ? 1 : snapshot.confidence,
            });
        }

        const nextStudentId = parsed.data.studentId !== undefined ? parsed.data.studentId : current.studentId;
        const nextMatchStatus = parsed.data.studentId !== undefined
            ? (parsed.data.studentId ? "manual" : "review")
            : current.matchStatus;
        const resultSnapshots = [...nextResults.values()];
        const nextBucket = computeSubmissionBucket({
            studentId: nextStudentId,
            matchStatus: nextMatchStatus,
            matchConfidence: current.matchConfidence,
            visualAlertsCount: parseJsonStringArray(current.visualAlerts).length,
            hasUnverifiedKey: resultSnapshots.some((r) => r.answerSource === "ai_inferred"),
            results: resultSnapshots.map((r) => ({ type: r.type, verdict: r.verdict, confidence: r.confidence })),
        });

        await tx.gradingSubmission.update({
            where: { id },
            data: {
                ...(parsed.data.studentId !== undefined ? {
                    studentId: parsed.data.studentId,
                    matchStatus: nextMatchStatus,
                    ...(parsed.data.studentId ? { matchReason: JSON.stringify({ code: "manual" }) } : {}),
                } : {}),
                ...(parsed.data.handwritingLevel !== undefined ? { handwritingLevel: parsed.data.handwritingLevel } : {}),
                ...(parsed.data.neatnessLevel !== undefined ? { neatnessLevel: parsed.data.neatnessLevel } : {}),
                ...(parsed.data.attitudeLevel !== undefined ? { attitudeLevel: parsed.data.attitudeLevel } : {}),
                ...(parsed.data.processTags !== undefined ? { processTags: JSON.stringify(parsed.data.processTags) } : {}),
                ...(parsed.data.teacherComment !== undefined ? { teacherComment: parsed.data.teacherComment } : {}),
                ...(updatedResultCount > 0 ? { totalScore: totalScore(resultSnapshots.map((r) => ({ score: r.score }))) } : {}),
                reviewBucket: nextBucket,
            },
        });
        return "OK" as const;
    });

    if (txResult === "NOT_FOUND") return notFound("Submission not found");
    if (txResult === "LOCKED") return conflict("Submission is locked");
    if (txResult === "INVALID_STUDENT") return badRequest("Student not in class");

    const updated = await loadOwned(id, user.id);
    return NextResponse.json(serialize(updated!));
}

/** DELETE /api/grading/submissions/:id：删除拍错或重复的答卷（已导入的错题保留） */
export async function DELETE(_req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const result = await prisma.gradingSubmission.deleteMany({ where: { id, task: { userId: user.id } } });
    if (result.count === 0) return notFound("Submission not found");
    return NextResponse.json({ success: true });
}
