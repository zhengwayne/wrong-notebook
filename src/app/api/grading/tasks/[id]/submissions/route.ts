import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { consumeAiQuota } from "@/lib/ai-quota";
import { scheduleGrading } from "@/lib/grading-service";
import { imageDataUrlSchema, languageSchema, MAX_PAGES_PER_PAPER, MAX_PAPERS_PER_UPLOAD } from "@/lib/grading-api";

const schema = z.object({
    papers: z.array(z.object({
        images: z.array(imageDataUrlSchema).min(1).max(MAX_PAGES_PER_PAPER),
        studentId: z.string().min(1).nullish(),
    })).min(1).max(MAX_PAPERS_PER_UPLOAD),
    language: languageSchema,
});

/** POST /api/grading/tasks/:id/submissions：上传一叠答卷（每份可多页），在后台依次 AI 判分 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid papers", parsed.error.issues);

    const task = await prisma.gradingTask.findFirst({
        where: { id, userId: user.id },
        include: { class: { include: { students: { select: { id: true } } } }, _count: { select: { questions: true } } },
    });
    if (!task) return notFound("Grading task not found");
    if (task._count.questions === 0) return badRequest("Answer key is empty");

    const studentIds = new Set(task.class.students.map((student) => student.id));
    if (parsed.data.papers.some((paper) => paper.studentId && !studentIds.has(paper.studentId))) {
        return badRequest("Student not in class");
    }

    const created: string[] = [];
    for (const paper of parsed.data.papers) {
        // 每份答卷计一次 AI 调用，超出每日额度时停止（已上传的照常判分）
        const limited = await consumeAiQuota(user, 'grade');
        if (limited) {
            if (created.length === 0) return limited;
            break;
        }
        const submission = await prisma.gradingSubmission.create({
            data: { taskId: id, studentId: paper.studentId || null, images: JSON.stringify(paper.images) },
            select: { id: true },
        });
        created.push(submission.id);
    }
    scheduleGrading(created, parsed.data.language);
    return NextResponse.json({ ids: created, skipped: parsed.data.papers.length - created.length }, { status: 202 });
}
