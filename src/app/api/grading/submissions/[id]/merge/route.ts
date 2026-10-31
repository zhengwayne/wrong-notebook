import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, conflict, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { parseJsonStringArray } from "@/lib/grading";
import { scheduleGrading } from "@/lib/grading-service";
import { languageSchema, MAX_PAGES_PER_PAPER } from "@/lib/grading-api";

const schema = z.object({ targetId: z.string().min(1), language: languageSchema });

/** POST /api/grading/submissions/:id/merge：把这份答卷的页接到 targetId 后面（如背面被当成新的一份），并删除这份 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid merge", parsed.error.issues);
    if (parsed.data.targetId === id) return badRequest("Cannot merge into itself");
    const [source, target] = await Promise.all([id, parsed.data.targetId].map((submissionId) =>
        prisma.gradingSubmission.findFirst({ where: { id: submissionId, task: { userId: user.id } } })));
    if (!source || !target || source.taskId !== target.taskId) return notFound("Submission not found");
    if ([source, target].some((item) => item.status === 'confirmed' || item.status === 'grading')) return conflict("Submission is locked");
    const images = [...parseJsonStringArray(target.images), ...parseJsonStringArray(source.images)];
    if (images.length > MAX_PAGES_PER_PAPER) return badRequest("Too many pages");

    await prisma.$transaction([
        prisma.gradingResult.deleteMany({ where: { submissionId: target.id } }),
        prisma.gradingSubmission.update({ where: { id: target.id }, data: { images: JSON.stringify(images), status: 'pending', totalScore: null } }),
        prisma.gradingSubmission.delete({ where: { id } }),
    ]);
    scheduleGrading([target.id], parsed.data.language);
    return NextResponse.json({ id: target.id });
}
