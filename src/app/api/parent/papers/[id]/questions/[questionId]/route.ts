import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, forbidden, internalError, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/current-user";
import { createLogger } from "@/lib/logger";
import { PARENT_REVIEW_VERDICTS } from "@/lib/parent-paper-review";
import { updateParentPaperQuestion } from "@/lib/parent-paper-recognize";
import { ParentPaperStateError, ParentPaperValidationError } from "@/lib/parent-papers";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";

const logger = createLogger("api:parent:papers:question");

const patchSchema = z.object({
    overrideVerdict: z.enum(PARENT_REVIEW_VERDICTS).nullable().optional(),
    selected: z.boolean().optional(),
}).refine((value) => value.overrideVerdict !== undefined || value.selected !== undefined, {
    message: "Nothing to update",
});

/** PATCH /api/parent/papers/[id]/questions/[questionId] 家长覆盖判定或调整是否导入 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; questionId: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!parsePersonas(user.personas).includes("parent")) return forbidden("Parent persona required");
    try {
        const { id, questionId } = await ctx.params;
        const body = patchSchema.parse(await req.json());
        const paper = await updateParentPaperQuestion(prisma, user.id, id, questionId, body);
        if (!paper) return notFound("Paper not found");
        return NextResponse.json(paper);
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid question update", error.issues);
        if (error instanceof ParentPaperValidationError) return notFound("Question not found");
        if (error instanceof ParentPaperStateError) {
            if (error.message === "ALREADY_CONFIRMED") return badRequest("Paper already confirmed");
            return badRequest("Paper is not ready to edit");
        }
        logger.error({ error }, "Failed to update parent paper question");
        return internalError("Failed to update question");
    }
}
