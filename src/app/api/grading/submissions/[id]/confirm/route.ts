import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { badRequest, internalError, notFound, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { confirmSubmission } from "@/lib/grading-service";

const logger = createLogger('api:grading:confirm');

/** POST /api/grading/submissions/:id/confirm：确认判分，把错题导入该学生的错题本 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    try {
        const result = await confirmSubmission(id, user.id);
        if (!result) return notFound("Submission not found");
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof Error && error.message === 'STUDENT_REQUIRED') return badRequest("Assign a student first");
        logger.error({ error }, '确认答卷失败');
        return internalError("Failed to confirm submission");
    }
}
