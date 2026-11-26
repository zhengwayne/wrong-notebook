import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { getParentPaper, omitPageImages, wantsPageImages } from "@/lib/parent-papers";

const logger = createLogger("api:parent:papers:id");

/** GET /api/parent/papers/[id] 查看一份已保存的试卷 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!parsePersonas(user.personas).includes("parent")) return forbidden("Parent persona required");
    try {
        const { id } = await ctx.params;
        const paper = await getParentPaper(prisma, user.id, id);
        if (!paper) return notFound("Paper not found");
        return NextResponse.json(wantsPageImages(req) ? paper : omitPageImages(paper));
    } catch (error) {
        logger.error({ error }, "Failed to load parent paper");
        return internalError("Failed to load paper");
    }
}
