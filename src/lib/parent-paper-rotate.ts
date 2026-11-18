/**
 * 家长试卷页旋转：旋转当前页图片，并把该页上的题框变换到同一坐标系。
 */
import type { PrismaClient } from "@prisma/client";
import { getOwnedChildLearner, LearnerNotFoundError } from "@/lib/learners";
import {
    getParentPaper,
    PARENT_PAPER_STATUS,
    ParentPaperStateError,
    ParentPaperValidationError,
    type ParentPaperDetail,
} from "@/lib/parent-papers";
import { isClockwiseRotation, transformNormalizedBBox, type ClockwiseRotation } from "@/lib/parent-paper-bbox";
import { validateQuestionBBox, type QuestionBBox } from "@/lib/parent-paper-review";
import { rotateImageDataUrl } from "@/lib/server/page-orientation";

function parseBbox(value: string | null | undefined): QuestionBBox | null {
    if (!value) return null;
    try {
        return validateQuestionBBox(JSON.parse(value), Number.MAX_SAFE_INTEGER);
    } catch {
        return null;
    }
}

export async function rotateParentPaperPage(
    db: PrismaClient,
    userId: string,
    paperId: string,
    params: { pageIndex: number; degrees: ClockwiseRotation },
): Promise<ParentPaperDetail | null> {
    if (!isClockwiseRotation(params.degrees) || params.degrees === 0) {
        throw new ParentPaperValidationError("INVALID_ROTATION");
    }
    if (!Number.isInteger(params.pageIndex) || params.pageIndex < 0) {
        throw new ParentPaperValidationError("INVALID_PAGE_INDEX");
    }

    const paper = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: {
            learner: { select: { id: true } },
            pages: { orderBy: { position: "asc" } },
            questions: { orderBy: { position: "asc" } },
        },
    });
    if (!paper) return null;
    const child = await getOwnedChildLearner(db, userId, paper.learnerId);
    if (!child) throw new LearnerNotFoundError();
    if (paper.status === PARENT_PAPER_STATUS.recognizing) {
        throw new ParentPaperStateError("ALREADY_RECOGNIZING");
    }
    const page = paper.pages[params.pageIndex];
    if (!page) throw new ParentPaperValidationError("INVALID_PAGE_INDEX");

    const rotated = await rotateImageDataUrl(page.imageUrl, params.degrees);
    let rotatedOriginal: string | null = null;
    if (page.originalImageUrl) {
        rotatedOriginal = (await rotateImageDataUrl(page.originalImageUrl, params.degrees)).dataUrl;
    }

    await db.$transaction(async (tx) => {
        await tx.parentPaperPage.update({
            where: { id: page.id },
            data: {
                imageUrl: rotated.dataUrl,
                ...(page.originalImageUrl ? { originalImageUrl: rotatedOriginal } : {}),
            },
        });
        for (const question of paper.questions) {
            const bbox = parseBbox(question.bbox);
            if (!bbox || bbox.pageIndex !== params.pageIndex) continue;
            const next = transformNormalizedBBox(bbox, params.degrees);
            await tx.parentPaperQuestion.update({
                where: { id: question.id },
                data: { bbox: JSON.stringify(next) },
            });
        }
        await tx.parentPaper.update({
            where: { id: paperId },
            data: { version: { increment: 1 } },
        });
    });

    return getParentPaper(db, userId, paperId);
}
