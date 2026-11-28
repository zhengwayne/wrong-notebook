import { NextResponse } from "next/server";
import { forbidden, internalError, notFound, unauthorized } from "@/lib/api-errors";
import { getCurrentUser } from "@/lib/current-user";
import { createLogger } from "@/lib/logger";
import { cropDataUrlRegion } from "@/lib/parent-paper-crop";
import { getParentPaper, questionImageSource } from "@/lib/parent-papers";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";

const logger = createLogger("api:parent:papers:question-image");

/**
 * GET /api/parent/papers/[id]/questions/[questionId]/image
 * 小程序题目详情：只回这道题裁出来的图（data URL），不用下载整份试卷的所有页。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; questionId: string }> }) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!parsePersonas(user.personas).includes("parent")) return forbidden("Parent persona required");
    try {
        const { id, questionId } = await ctx.params;
        const paper = await getParentPaper(prisma, user.id, id);
        if (!paper) return notFound("Paper not found");
        const source = questionImageSource(paper, questionId);
        if (!source) return notFound("Question image not found");
        const result = source.bbox ? await cropDataUrlRegion(source.imageUrl, source.bbox) : { imageUrl: source.imageUrl, cropped: false };
        return NextResponse.json({ pageIndex: source.pageIndex, imageUrl: result.imageUrl, cropped: result.cropped });
    } catch (error) {
        logger.error({ error }, "Failed to load parent paper question image");
        return internalError("Failed to load question image");
    }
}
