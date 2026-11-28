import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, conflict, internalError, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { confirmSubmission } from "@/lib/grading-service";

const logger = createLogger('api:grading:confirm');

const bodySchema = z.object({
    expectedVersion: z.number().int().nonnegative().optional(),
});

/** POST /api/grading/submissions/:id/confirm：确认判分，把错题导入该学生的错题本 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    try {
        const body = req.headers.get("content-type")?.includes("application/json")
            ? bodySchema.parse(await req.json().catch(() => ({})))
            : {};
        const result = body.expectedVersion !== undefined
            ? await confirmSubmission(id, user.id, { expectedVersion: body.expectedVersion })
            : await confirmSubmission(id, user.id);
        if (!result) return notFound("Submission not found");
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid confirm request", error.issues);
        if (error instanceof Error && error.message === 'STUDENT_REQUIRED') return badRequest("Assign a student first");
        if (error instanceof Error && error.message === 'SUBMISSION_LOCKED') return conflict("Submission is locked");
        if (error instanceof Error && error.message === 'VERSION_CONFLICT') return conflict("Submission was modified before confirmation completed");
        logger.error({ error }, '确认答卷失败');
        return internalError("Failed to confirm submission");
    }
}
