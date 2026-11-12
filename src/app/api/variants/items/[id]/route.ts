import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, notFound, badRequest, validationError, conflict, internalError } from "@/lib/api-errors";
import { reviewVariantItem } from "@/lib/variant/service";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:variants:items');
const schema = z.object({
    action: z.enum(['approve', 'reject', 'edit']),
    questionText: z.string().trim().max(8000).optional(),
    answerText: z.string().trim().max(4000).optional(),
    analysis: z.string().trim().max(8000).optional(),
    note: z.string().trim().max(500).optional(),
});

/** PATCH /api/variants/items/:id：批准、编辑后批准，或拒绝一道变式题 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError('Invalid review', parsed.error.issues);
    const { id } = await params;
    try {
        const result = await reviewVariantItem(user.id, id, parsed.data.action, {
            questionText: parsed.data.questionText,
            answerText: parsed.data.answerText,
            analysis: parsed.data.analysis,
        }, parsed.data.note);
        if (!result) return notFound('Item not found');
        if ('error' in result) return result.error === 'ALREADY_APPROVED' ? conflict('Already approved') : badRequest(result.error ?? 'INCOMPLETE');
        return NextResponse.json(result);
    } catch (error) {
        logger.error({ error }, '审核变式题失败');
        return internalError('Failed to review variant');
    }
}
