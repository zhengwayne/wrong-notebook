import { NextResponse } from "next/server";
import { z } from "zod";
import { notFound, validationError } from "@/lib/api-errors";
import { confirmSubmission } from "@/lib/grading-service";
import { prisma } from "@/lib/prisma";
import { defineApiRoute } from "@/lib/server/api-route";

const batchSchema = z.object({
    submissionIds: z.array(z.string().min(1)).max(200).optional(),
});

/**
 * POST /api/grading/tasks/:id/confirm-batch
 * 一键批量确认该任务下的全部（或指定）绿灯免检答卷并幂等归档错题，消除逐份点开确认的机械操作。
 */
export const POST = defineApiRoute({ auth: "user" }, async (req, { user, params }) => {
    const { id: taskId } = await (params as Promise<{ id: string }>);
    const body = await req.json().catch(() => ({}));
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) {
        return validationError("Invalid batch confirm payload", parsed.error.issues);
    }

    const task = await prisma.gradingTask.findFirst({
        where: { id: taskId, userId: user.id },
        select: { id: true },
    });
    if (!task) {
        return notFound("Grading task not found");
    }

    const candidates = await prisma.gradingSubmission.findMany({
        where: {
            taskId,
            status: "graded",
            studentId: { not: null },
            ...(parsed.data.submissionIds?.length
                ? { id: { in: parsed.data.submissionIds } }
                : { reviewBucket: "green" }),
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
    });

    let confirmedCount = 0;
    let importedCount = 0;
    let skippedCount = 0;

    for (const candidate of candidates) {
        try {
            const res = await confirmSubmission(candidate.id, user.id);
            if (res) {
                confirmedCount += 1;
                importedCount += res.importedCount;
            } else {
                skippedCount += 1;
            }
        } catch {
            skippedCount += 1;
        }
    }

    return NextResponse.json({
        confirmedCount,
        importedCount,
        skippedCount,
    });
});
