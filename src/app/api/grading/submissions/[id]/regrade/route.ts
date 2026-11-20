import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { conflict, notFound, unauthorized } from "@/lib/api-errors";
import { consumeAiQuota } from "@/lib/ai-quota";
import { isSubmissionQueued, scheduleGrading } from "@/lib/grading-service";

/** POST /api/grading/submissions/:id/regrade：重新 AI 判分（会覆盖老师的改判） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const submission = await prisma.gradingSubmission.findFirst({ where: { id, task: { userId: user.id } }, select: { status: true } });
    if (!submission) return notFound("Submission not found");
    if (submission.status === 'confirmed') return conflict("Submission already confirmed");
    if (submission.status === 'grading' || isSubmissionQueued?.(id)) return conflict("Submission is being graded");

    const limited = await consumeAiQuota(user, 'grade');
    if (limited) return limited;

    const claimed = await prisma.gradingSubmission.updateMany({
        where: { id, task: { userId: user.id }, status: { notIn: ['confirmed', 'grading'] } },
        data: { status: 'pending', error: null },
    });
    if (claimed.count === 0) return conflict("Submission is locked");

    const body = await req.json().catch(() => ({})) as { language?: string };
    scheduleGrading([id], body.language === 'en' ? 'en' : 'zh');
    return NextResponse.json({ success: true }, { status: 202 });
}
