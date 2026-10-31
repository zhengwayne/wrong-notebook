import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/current-user";
import { internalError, notFound, unauthorized, validationError } from "@/lib/api-errors";
import { consumeAiQuota } from "@/lib/ai-quota";
import { createLogger } from "@/lib/logger";
import { readAnswerKeyFromImages } from "@/lib/grading-service";
import { imageDataUrlSchema, languageSchema, MAX_PAGES_PER_PAPER } from "@/lib/grading-api";

const logger = createLogger('api:grading:key-image');

const schema = z.object({
    images: z.array(imageDataUrlSchema).min(1).max(MAX_PAGES_PER_PAPER),
    language: languageSchema,
});

/** POST /api/grading/tasks/:id/key-image：拍照识别答案卷，返回题目清单供老师校对后保存（不直接覆盖答案） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return validationError("Invalid answer key images", parsed.error.issues);
    const task = await prisma.gradingTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!task) return notFound("Grading task not found");

    const limited = await consumeAiQuota(user, 'grade');
    if (limited) return limited;
    try {
        const questions = await readAnswerKeyFromImages(parsed.data.images, parsed.data.language);
        await prisma.gradingTask.update({ where: { id }, data: { keyImageUrl: parsed.data.images[0] } });
        return NextResponse.json({ questions });
    } catch (error) {
        logger.error({ error }, '识别答案卷失败');
        return internalError("Failed to read answer key");
    }
}
