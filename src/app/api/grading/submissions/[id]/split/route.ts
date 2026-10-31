import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, conflict, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { parseJsonStringArray } from "@/lib/grading";
import { scheduleGrading } from "@/lib/grading-service";
import { languageSchema } from "@/lib/grading-api";

const schema = z.object({ fromPage: z.number().int().min(1), language: languageSchema });

/** POST /api/grading/submissions/:id/split：从第 fromPage 页（0 起）拆出一份新答卷，两份都重新判分 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid split", parsed.error.issues);
    const submission = await prisma.gradingSubmission.findFirst({ where: { id, task: { userId: user.id } } });
    if (!submission) return notFound("Submission not found");
    if (submission.status === 'confirmed' || submission.status === 'grading') return conflict("Submission is locked");
    const images = parseJsonStringArray(submission.images);
    if (parsed.data.fromPage >= images.length) return badRequest("Nothing to split");

    const created = await prisma.$transaction(async (tx) => {
        await tx.gradingResult.deleteMany({ where: { submissionId: id } });
        await tx.gradingSubmission.update({ where: { id }, data: { images: JSON.stringify(images.slice(0, parsed.data.fromPage)), status: 'pending', totalScore: null } });
        // 拆出的部分身份未知，判分时按卷头重新匹配
        return tx.gradingSubmission.create({ data: { taskId: submission.taskId, images: JSON.stringify(images.slice(parsed.data.fromPage)) }, select: { id: true } });
    });
    scheduleGrading([id, created.id], parsed.data.language);
    return NextResponse.json({ id: created.id }, { status: 201 });
}
