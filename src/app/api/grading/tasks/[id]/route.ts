import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { conflict, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { keyQuestionData, loadTaskRoster, scheduleGrading, taskClassIds, toKeyQuestion } from "@/lib/grading-service";
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
                    matchStatus: true, matchConfidence: true, matchReason: true, matchCandidates: true, status: true,
                    reviewBucket: true, handwritingLevel: true, neatnessLevel: true, attitudeLevel: true,
                    totalScore: true, error: true, importedCount: true, createdAt: true,
                },
            },
        },
    });
    if (!task) return notFound("Grading task not found");
    const pageCountRows = typeof prisma.$queryRaw === "function"
        ? await prisma.$queryRaw<Array<{ id: string; pageCount: bigint | number }>>`
            SELECT id, CASE WHEN json_valid(images) THEN json_array_length(images) ELSE 0 END AS pageCount
            FROM GradingSubmission
            WHERE taskId = ${id}
        `
        : [];
    const pageCountById = new Map(pageCountRows.map((row) => [row.id, Number(row.pageCount ?? 0)]));
    const roster = await loadTaskRoster(task);
    const classes = await prisma.gradingClass.findMany({ where: { id: { in: taskClassIds(task) }, userId: user.id }, select: { id: true, name: true } });
    return NextResponse.json({
        id: task.id,
        title: task.title,
        subjectName: task.subjectName,
        taskMode: task.taskMode,
        scoringMode: task.scoringMode,
        allowSelfSubmit: Boolean(task.allowSelfSubmit && task.submitTokenHash),
        deadline: task.deadline,
        classId: task.classId,
        className: task.class.name,
        classIds: classes.map((item) => item.id),
        classNames: classes.map((item) => item.name),
        students: roster,
        questions: task.questions.map(toKeyQuestion),
        submissions: task.submissions.map(({ matchReason, matchCandidates, ...submission }) => ({
            ...submission,
            matchReason: parseMatchReason(matchReason),
            matchCandidates: parseCandidates(matchCandidates),
            pageCount: pageCountById.get(submission.id) ?? 0,
        })),
    });
}

/** PUT /api/grading/tasks/:id：修改标题、学科或替换答案（若含已确认/判分中答卷则拒删答案；替换后自动重判待评答卷） */
export async function PUT(req: Request, { params }: Params) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid grading task", parsed.error.issues);
    const task = await prisma.gradingTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!task) return notFound("Grading task not found");

    const { questions, ...fields } = parsed.data;
    const txOutcome = await prisma.$transaction(async (tx) => {
        if (questions) {
            const lockedCount = await tx.gradingSubmission.count({
                where: { taskId: id, status: { in: ["confirmed", "grading"] } },
            });
            if (lockedCount > 0) {
                return { locked: true as const, resetIds: [] as string[] };
            }
        }
        await tx.gradingTask.update({ where: { id }, data: fields });
        let resetIds: string[] = [];
        if (questions) {
            const resettable = await tx.gradingSubmission.findMany({
                where: { taskId: id, status: { in: ["graded", "failed", "pending"] } },
                select: { id: true },
            });
            resetIds = resettable.map((item) => item.id);
            await tx.gradingKeyQuestion.deleteMany({ where: { taskId: id } });
            await tx.gradingKeyQuestion.createMany({
                data: questions.map((question, index) => ({ ...keyQuestionData(question, index), taskId: id })),
            });
            await tx.gradingSubmission.updateMany({
                where: { taskId: id, status: { in: ["graded", "failed"] } },
                data: { status: "pending", totalScore: null },
            });
        }
        return { locked: false as const, resetIds };
    });

    if (txOutcome.locked) {
        return conflict("已有正在判分或已确认入库的答卷，无法全量替换标准答案");
    }
    if (txOutcome.resetIds.length > 0) {
        scheduleGrading(txOutcome.resetIds, "zh");
    }
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
