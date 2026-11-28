import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, conflict, forbidden, internalError, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/current-user";
import { createLogger } from "@/lib/logger";
import { confirmParentPaper } from "@/lib/parent-paper-recognize";
import { omitPageImages, ParentPaperStateError, wantsPageImages } from "@/lib/parent-papers";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { mpSafeBody } from "@/lib/server/mp-review-safe";

const logger = createLogger("api:parent:papers:confirm");

const bodySchema = z.object({
    questionIds: z.array(z.string().min(1)).optional(),
    language: z.enum(["zh", "en"]).optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
});

/** POST /api/parent/papers/[id]/confirm 把选中的错题导入孩子的学科错题本 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!parsePersonas(user.personas).includes("parent")) return forbidden("Parent persona required");
    try {
        const { id } = await ctx.params;
        const body = req.headers.get("content-type")?.includes("application/json")
            ? bodySchema.parse(await req.json().catch(() => ({})))
            : {};
        const result = await confirmParentPaper(prisma, user.id, id, body);
        if (!result) return notFound("Paper not found");
        return NextResponse.json(mpSafeBody(req, wantsPageImages(req) ? result : { ...result, paper: omitPageImages(result.paper) }));
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid confirm request", error.issues);
        if (error instanceof ParentPaperStateError) {
            if (error.message === "ALREADY_CONFIRMED") return conflict("Paper already confirmed");
            if (error.message === "VERSION_CONFLICT") return conflict("Paper was modified before confirmation completed");
            return badRequest("Paper is not ready to confirm");
        }
        logger.error({ error }, "Failed to confirm parent paper");
        return internalError("Failed to confirm paper");
    }
}
