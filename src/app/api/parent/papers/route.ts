import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/current-user";
import { unauthorized, forbidden, badRequest, validationError, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { LearnerNotFoundError } from "@/lib/learners";
import { runBoundedConcurrency } from "@/lib/grading-bbox-and-pool";
import { parsePersonas } from "@/lib/personas";
import { prisma } from "@/lib/prisma";
import { autoCropPaperImage } from "@/lib/parent-paper-autocrop";
import { createParentPaper, listParentPapers, omitPageImages, wantsPageImages, MAX_PARENT_ANSWER_KEY_IMAGES, MAX_PARENT_PAPER_PAGES, MAX_PARENT_PAGE_IMAGE_CHARS, ParentPaperValidationError, parentPaperSubjectKeySchema } from "@/lib/parent-papers";
import { ImageValidationError, normalizeImageDataUrl } from "@/lib/server/image-normalize";
import { uprightImageDataUrl } from "@/lib/server/page-orientation";
import { mpSafeBody } from "@/lib/server/mp-review-safe";

const logger = createLogger("api:parent:papers");

const pageSchema = z.object({
    imageUrl: z.string().min(1).max(MAX_PARENT_PAGE_IMAGE_CHARS),
});

const createSchema = z.object({
    learnerId: z.string().min(1),
    title: z.string().max(120).nullish(),
    subjectKey: parentPaperSubjectKeySchema.nullish(),
    pages: z.array(pageSchema).min(1).max(MAX_PARENT_PAPER_PAGES),
    answerKeyImages: z.array(z.string().min(1).max(MAX_PARENT_PAGE_IMAGE_CHARS)).max(MAX_PARENT_ANSWER_KEY_IMAGES).optional(),
});

function requireParent(user: { personas: string }) {
    return parsePersonas(user.personas).includes("parent");
}

/** GET /api/parent/papers?learnerId= 当前孩子的试卷列表 */
export async function GET(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!requireParent(user)) return forbidden("Parent persona required");
    const learnerId = new URL(req.url).searchParams.get("learnerId");
    if (!learnerId) return badRequest("learnerId is required");
    try {
        const papers = await listParentPapers(prisma, user.id, learnerId);
        return NextResponse.json(mpSafeBody(req, { papers }));
    } catch (error) {
        if (error instanceof LearnerNotFoundError) return notFound("Child not found");
        logger.error({ error }, "Failed to list parent papers");
        return internalError("Failed to list papers");
    }
}

/** POST /api/parent/papers 保存待识别的试卷草稿 */
export async function POST(req: Request) {
    const user = await getCurrentUser();
    if (!user) return unauthorized();
    if (!requireParent(user)) return forbidden("Parent persona required");
    try {
        const body = createSchema.parse(await req.json());
        const pages: Array<{ imageUrl: string; originalImageUrl?: string | null }> = new Array(body.pages.length);
        await runBoundedConcurrency(body.pages, 2, async (page, index) => {
            const upright = await uprightImageDataUrl(page.imageUrl);
            const cropped = await autoCropPaperImage(upright.dataUrl);
            pages[index] = {
                imageUrl: cropped.cropped ? cropped.imageUrl : upright.dataUrl,
                originalImageUrl: upright.dataUrl,
            };
        });
        let answerKeyImages: string[] | undefined;
        if (body.answerKeyImages) {
            const normalizedKeys: string[] = new Array(body.answerKeyImages.length);
            await runBoundedConcurrency(body.answerKeyImages, 2, async (img, index) => {
                normalizedKeys[index] = (await normalizeImageDataUrl(img)).dataUrl;
            });
            answerKeyImages = normalizedKeys;
        }
        const paper = await createParentPaper(prisma, user.id, { ...body, pages, answerKeyImages });
        return NextResponse.json(mpSafeBody(req, wantsPageImages(req) ? paper : omitPageImages(paper)), { status: 201 });
    } catch (error) {
        if (error instanceof z.ZodError) return validationError("Invalid paper", error.issues);
        if (error instanceof ImageValidationError) return badRequest("Invalid page image");
        if (error instanceof LearnerNotFoundError) return notFound("Child not found");
        if (error instanceof ParentPaperValidationError) {
            if (error.message === "PAGES_REQUIRED") return badRequest("At least one page is required");
            if (error.message === "TOO_MANY_PAGES") return badRequest(`At most ${MAX_PARENT_PAPER_PAGES} pages`);
            if (error.message === "TOO_MANY_ANSWER_KEY_IMAGES") return badRequest(`At most ${MAX_PARENT_ANSWER_KEY_IMAGES} answer-key images`);
            return badRequest("Invalid page image");
        }
        logger.error({ error }, "Failed to create parent paper");
        return internalError("Failed to save paper");
    }
}
