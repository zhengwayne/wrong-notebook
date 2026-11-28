import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, forbidden, notFound, unauthorized, validationError, conflict, internalError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/current-user";
import { LearnerNotFoundError } from "@/lib/learners";
import { createLogger } from "@/lib/logger";
import { ParentPaperStateError, ParentPaperValidationError } from "@/lib/parent-papers";
import { rotateParentPaperPage } from "@/lib/parent-paper-rotate";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";

const logger = createLogger("api:parent:papers:rotate");

const bodySchema = z.object({
    pageIndex: z.number().int().min(0),
    degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]),
});

/** POST /api/parent/papers/[id]/rotate 旋转一页并同步变换题框 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!parsePersonas(user.personas).includes("parent")) return forbidden("Parent persona required");

    try {
        const { id } = await ctx.params;
        const body = bodySchema.parse(await req.json());
        const paper = await rotateParentPaperPage(prisma, user.id, id, body);
        if (!paper) return notFound("Paper not found");
        return NextResponse.json(paper);
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid rotate request", error.issues);
        if (error instanceof LearnerNotFoundError) return notFound("Child not found");
        if (error instanceof ParentPaperStateError) {
            if (error.message === "ALREADY_RECOGNIZING") return conflict("Recognition already in progress");
            if (error.message === "ALREADY_CONFIRMED") return conflict("Paper already confirmed");
            if (error.message === "VERSION_CONFLICT") return conflict("Paper modified concurrently, please retry");
            return badRequest(error.message);
        }
        if (error instanceof ParentPaperValidationError) return badRequest(error.message);
        logger.error({ error }, "Failed to rotate parent paper page");
        return internalError("Failed to rotate page");
    }
}
