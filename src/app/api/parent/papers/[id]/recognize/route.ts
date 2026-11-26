import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeAiQuota, releaseAiQuota } from "@/lib/ai-quota";
import { conflict, forbidden, notFound, unauthorized, badRequest, validationError, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/current-user";
import { createLogger } from "@/lib/logger";
import { MAX_PARENT_ANSWER_KEY_IMAGES, MAX_PARENT_PAGE_IMAGE_CHARS, omitPageImages, ParentPaperStateError, ParentPaperValidationError, wantsPageImages } from "@/lib/parent-papers";
import { startParentPaperRecognition } from "@/lib/parent-paper-recognize";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";

const logger = createLogger("api:parent:papers:recognize");

const bodySchema = z.object({
    answerKeyImages: z.array(z.string().min(1).max(MAX_PARENT_PAGE_IMAGE_CHARS)).max(MAX_PARENT_ANSWER_KEY_IMAGES).optional(),
    language: z.enum(["zh", "en"]).optional(),
});

/** POST /api/parent/papers/[id]/recognize 开始后台识别，立即返回 202 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!parsePersonas(user.personas).includes("parent")) return forbidden("Parent persona required");

    const limited = await consumeAiQuota(user, "grade");
    if (limited) return limited;

    try {
        const { id } = await ctx.params;
        const body = req.headers.get("content-type")?.includes("application/json")
            ? bodySchema.parse(await req.json().catch(() => ({})))
            : {};
        const started = await startParentPaperRecognition(prisma, user.id, id, body);
        if (!started) {
            await releaseAiQuota(user.id);
            return notFound("Paper not found");
        }
        return NextResponse.json(wantsPageImages(req) ? started : { ...started, paper: omitPageImages(started.paper) }, { status: 202 });
    } catch (error) {
        await releaseAiQuota(user.id);
        if (error instanceof z.ZodError) return validationError("Invalid recognition request", error.issues);
        if (error instanceof ParentPaperStateError) {
            if (error.message === "ALREADY_RECOGNIZING") return conflict("Recognition already in progress");
            if (error.message === "ALREADY_CONFIRMED") return badRequest("Paper already confirmed");
            return badRequest(error.message);
        }
        if (error instanceof ParentPaperValidationError) {
            if (error.message === "PAGES_REQUIRED") return badRequest("At least one page is required");
            return badRequest("Invalid answer-key image");
        }
        logger.error({ error }, "Failed to start parent paper recognition");
        return internalError("Failed to start recognition");
    }
}
