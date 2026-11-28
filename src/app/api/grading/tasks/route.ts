import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { notFound, unauthorized, validationError } from "@/lib/api-errors";
import { parseQuickAnswerKey } from "@/lib/grading";
import { SCORING_MODES, TASK_MODES } from "@/lib/grading-grades";
import { ensureDefaultQuickClass } from "@/lib/grading-quick-key";
import { buildKeyFromExam, keyQuestionData } from "@/lib/grading-service";
import { keyQuestionsSchema } from "@/lib/grading-api";
import type { KeyQuestionInput } from "@/lib/grading";

const createSchema = z.object({
    title: z.string().trim().min(1).max(200),
    classId: z.string().trim().min(1).optional(),
    taskMode: z.enum(TASK_MODES).default('standard'),
    scoringMode: z.enum(SCORING_MODES).default('numeric'),
    /** 同一次考试一起收卷的其他班级 */
    extraClassIds: z.array(z.string().min(1)).max(20).default([]),
    subjectName: z.string().trim().min(1).max(50).default('数学'),
    /** 答案来源：已有试卷、快速录入文本、逐题列表，或随堂速批免预录答案 */
    examPaperId: z.string().min(1).optional(),
    keyText: z.string().max(50000).optional(),
    questions: keyQuestionsSchema.optional(),
    defaultScore: z.number().min(0).max(100).default(1),
});

/** GET /api/grading/tasks：改卷任务列表 */
export async function GET() {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const tasks = await prisma.gradingTask.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        include: {
            class: { select: { name: true, _count: { select: { students: true } } } },
            _count: { select: { questions: true, submissions: true } },
            submissions: { select: { status: true } },
        },
    });
    return NextResponse.json(tasks.map((task) => ({
        id: task.id,
        title: task.title,
        subjectName: task.subjectName,
        taskMode: task.taskMode,
        scoringMode: task.scoringMode,
        className: task.class.name,
        studentCount: task.class._count.students,
        questionCount: task._count.questions,
        submissionCount: task._count.submissions,
        confirmedCount: task.submissions.filter((submission) => submission.status === 'confirmed').length,
        createdAt: task.createdAt,
    })));
}

/** POST /api/grading/tasks：新建改卷任务并保存答案（随堂速批模式支持免预建班级与免预录答案） */
export async function POST(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid grading task", parsed.error.issues);
    const body = parsed.data;

    let resolvedClassId = body.classId;
    if (!resolvedClassId) {
        if (body.taskMode === 'quick') {
            const quickClass = await ensureDefaultQuickClass(prisma, user.id);
            resolvedClassId = quickClass.id;
        } else {
            return validationError("Class is required for standard mode");
        }
    }

    const classIds = [...new Set([resolvedClassId, ...body.extraClassIds])];
    const owned = await prisma.gradingClass.count({ where: { id: { in: classIds }, userId: user.id } });
    if (owned !== classIds.length) return notFound("Class not found");

    let questions: KeyQuestionInput[] = body.questions || [];
    if (body.examPaperId) {
        const fromExam = await buildKeyFromExam(body.examPaperId, user.id);
        if (!fromExam) return notFound("Exam paper not found");
        questions = fromExam.map((q) => ({ ...q, answerSource: 'exam_paper' }));
    } else if (body.keyText) {
        const { questions: parsedKey, errors } = parseQuickAnswerKey(body.keyText, body.defaultScore);
        if (errors.length) return validationError("Invalid answer key lines", { lines: errors });
        const validated = keyQuestionsSchema.safeParse(parsedKey);
        if (!validated.success) return validationError("Invalid parsed answer key", validated.error.issues);
        questions = validated.data;
    }

    const task = await prisma.gradingTask.create({
        data: {
            userId: user.id,
            classId: resolvedClassId,
            title: body.title,
            subjectName: body.subjectName,
            taskMode: body.taskMode,
            scoringMode: body.scoringMode,
            examPaperId: body.examPaperId || null,
            extraClassIds: classIds.length > 1 ? JSON.stringify(classIds.slice(1)) : null,
            questions: { create: questions.map((question, index) => keyQuestionData(question, index)) },
        },
        select: { id: true },
    });
    return NextResponse.json({ id: task.id, questionCount: questions.length }, { status: 201 });
}
