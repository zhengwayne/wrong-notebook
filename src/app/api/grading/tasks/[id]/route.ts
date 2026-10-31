import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { notFound, unauthorized, validationError } from "@/lib/api-errors";
import { parseJsonStringArray } from "@/lib/grading";
import { keyQuestionData, loadTaskRoster, taskClassIds, toKeyQuestion } from "@/lib/grading-service";
import { parseCandidates, parseMatchReason } from "@/lib/grading-match-json";
import { keyQuestionsSchema } from "@/lib/grading-api";

type Params = { params: Promise<{ id: string }> };

const updateSchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    subjectName: z.string().trim().min(1).max(50).optional(),
    questions: keyQuestionsSchema.optional(),
});

/** GET /api/grading/tasks/:id：任务、答案、花名册与答卷列表（不含图片） */
export async function GET(_req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        include: {
            class: { select: { name: true } },
            questions: { orderBy: { order: 'asc' } },
            submissions: {
                orderBy: { createdAt: 'asc' },
                select: {
                    id: true, studentId: true, detectedName: true, detectedClass: true, detectedStudentNo: true,
                    matchStatus: true, matchConfidence: true, matchReason: true, matchCandidates: true, status: true, totalScore: true, error: true,
                    importedCount: true, images: true, createdAt: true,
                },
            },
        },
    });
    if (!task) return notFound("Grading task not found");
    const roster = await loadTaskRoster(task);
    const classes = await prisma.gradingClass.findMany({ where: { id: { in: taskClassIds(task) }, userId: user.id }, select: { id: true, name: true } });
    return NextResponse.json({
        id: task.id,
        title: task.title,
        subjectName: task.subjectName,
        classId: task.classId,
        className: task.class.name,
        classIds: classes.map((item) => item.id),
        classNames: classes.map((item) => item.name),
        students: roster,
        questions: task.questions.map(toKeyQuestion),
        submissions: task.submissions.map(({ images, matchReason, matchCandidates, ...submission }) => ({
            ...submission,
            matchReason: parseMatchReason(matchReason),
            matchCandidates: parseCandidates(matchCandidates),
            pageCount: parseJsonStringArray(images).length,
        })),
    });
}

/** PUT /api/grading/tasks/:id：修改标题、学科或替换答案（替换答案会清空已有判分，需要重新判分） */
export async function PUT(req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid grading task", parsed.error.issues);
    const task = await prisma.gradingTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!task) return notFound("Grading task not found");

    const { questions, ...fields } = parsed.data;
    await prisma.$transaction(async (tx) => {
        await tx.gradingTask.update({ where: { id }, data: fields });
        if (questions) {
            await tx.gradingKeyQuestion.deleteMany({ where: { taskId: id } });
            await tx.gradingKeyQuestion.createMany({ data: questions.map((question, index) => ({ ...keyQuestionData(question, index), taskId: id })) });
            await tx.gradingSubmission.updateMany({ where: { taskId: id, status: { in: ['graded', 'failed'] } }, data: { status: 'pending', totalScore: null } });
        }
    });
    return NextResponse.json({ success: true });
}

/** DELETE /api/grading/tasks/:id */
export async function DELETE(_req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const result = await prisma.gradingTask.deleteMany({ where: { id, userId: user.id } });
    if (result.count === 0) return notFound("Grading task not found");
    return NextResponse.json({ success: true });
}
