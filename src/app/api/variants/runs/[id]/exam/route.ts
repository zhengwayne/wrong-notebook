import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest, validationError, internalError } from "@/lib/api-errors";
import { createExamFromApproved } from "@/lib/variant/service";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:variants:exam');
const schema = z.object({ title: z.string().trim().max(100).optional() });

/** POST /api/variants/runs/:id/exam：把已批准的变式题组成可打印试卷 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return validationError('Invalid exam title', parsed.error.issues);
    const { id } = await params;
    try {
        const result = await createExamFromApproved(user.id, id, parsed.data.title);
        if (!result) return notFound('Run not found');
        if ('error' in result) return badRequest(result.error || 'NO_APPROVED');
        return NextResponse.json(result, { status: 201 });
    } catch (error) {
        logger.error({ error }, '从变式组成试卷失败');
        return internalError('Failed to create exam');
    }
}
