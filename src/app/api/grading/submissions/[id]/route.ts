import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { applyTeacherOverride, parseJsonStringArray, totalScore } from "@/lib/grading";
import { toKeyQuestion } from "@/lib/grading-service";
import { resultOverrideSchema } from "@/lib/grading-api";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.object({
    studentId: z.string().min(1).nullable().optional(),
    results: z.array(resultOverrideSchema).max(200).optional(),
});

async function loadOwned(id: string, userId: string) {
    return prisma.gradingSubmission.findFirst({
        where: { id, task: { userId } },
        include: {
            task: { select: { id: true, classId: true, title: true } },
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
        studentId: submission.studentId,
        studentName: submission.student?.name || null,
        detectedName: submission.detectedName,
        status: submission.status,
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

/** PATCH /api/grading/submissions/:id：指定学生、老师改判（一键对/错或给分），重新计算总分 */
export async function PATCH(req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid submission update", parsed.error.issues);
    const submission = await loadOwned(id, user.id);
    if (!submission) return notFound("Submission not found");

    if (parsed.data.studentId) {
        const student = await prisma.gradingStudent.findFirst({ where: { id: parsed.data.studentId, classId: submission.task.classId }, select: { id: true } });
        if (!student) return badRequest("Student not in class");
    }

    const byId = new Map(submission.results.map((result) => [result.id, result]));
    const scores = new Map(submission.results.map((result) => [result.id, result.score]));
    const updates = (parsed.data.results || []).flatMap((override) => {
        const current = byId.get(override.id);
        if (!current) return [];
        const next = applyTeacherOverride(current.keyQuestion.maxScore, override);
        scores.set(current.id, next.score);
        return [prisma.gradingResult.update({ where: { id: current.id }, data: next })];
    });

    await prisma.$transaction([
        ...updates,
        prisma.gradingSubmission.update({
            where: { id },
            data: {
                ...(parsed.data.studentId !== undefined ? { studentId: parsed.data.studentId } : {}),
                ...(updates.length ? { totalScore: totalScore([...scores.values()].map((score) => ({ score }))) } : {}),
            },
        }),
    ]);

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
