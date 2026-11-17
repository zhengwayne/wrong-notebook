/**
 * 家长为当前孩子上传的试卷：阶段 1 只保存页图片，状态为待识别。
 * 确认前不会写入错题本。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { getOwnedChildLearner, LearnerNotFoundError } from "@/lib/learners";

type Db = PrismaClient | Prisma.TransactionClient;

export const PARENT_PAPER_STATUS = {
    pendingRecognition: "pending_recognition",
} as const;

export type ParentPaperStatus = (typeof PARENT_PAPER_STATUS)[keyof typeof PARENT_PAPER_STATUS];

export const MAX_PARENT_PAPER_PAGES = 20;
export const MAX_PARENT_PAGE_IMAGE_CHARS = 3 * 1024 * 1024;

export class ParentPaperValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParentPaperValidationError";
    }
}

const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i;

export function isPaperPageImage(value: string): boolean {
    return IMAGE_DATA_URL.test(value) && value.length <= MAX_PARENT_PAGE_IMAGE_CHARS;
}

export interface ParentPaperPageInput {
    imageUrl: string;
}

export interface ParentPaperSummary {
    id: string;
    learnerId: string;
    learnerName: string;
    title: string | null;
    status: string;
    pageCount: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface ParentPaperDetail extends ParentPaperSummary {
    pages: Array<{ id: string; position: number; imageUrl: string }>;
}

function toSummary(paper: {
    id: string;
    learnerId: string;
    title: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    learner: { name: string };
    pages: Array<{ id: string }>;
}): ParentPaperSummary {
    return {
        id: paper.id,
        learnerId: paper.learnerId,
        learnerName: paper.learner.name,
        title: paper.title,
        status: paper.status,
        pageCount: paper.pages.length,
        createdAt: paper.createdAt,
        updatedAt: paper.updatedAt,
    };
}

export async function listParentPapers(db: Db, userId: string, learnerId: string): Promise<ParentPaperSummary[]> {
    const child = await getOwnedChildLearner(db, userId, learnerId);
    if (!child) throw new LearnerNotFoundError();
    const papers = await db.parentPaper.findMany({
        where: { userId, learnerId },
        include: { learner: { select: { name: true } }, pages: { select: { id: true } } },
        orderBy: { createdAt: "desc" },
    });
    return papers.map(toSummary);
}

export async function getParentPaper(db: Db, userId: string, paperId: string): Promise<ParentPaperDetail | null> {
    const paper = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: {
            learner: { select: { name: true } },
            pages: { orderBy: { position: "asc" }, select: { id: true, position: true, imageUrl: true } },
        },
    });
    if (!paper) return null;
    return { ...toSummary(paper), pages: paper.pages };
}

export async function createParentPaper(
    db: Db,
    userId: string,
    params: { learnerId: string; title?: string | null; pages: ParentPaperPageInput[] },
): Promise<ParentPaperDetail> {
    const child = await getOwnedChildLearner(db, userId, params.learnerId);
    if (!child) throw new LearnerNotFoundError();
    if (!params.pages.length) throw new ParentPaperValidationError("PAGES_REQUIRED");
    if (params.pages.length > MAX_PARENT_PAPER_PAGES) throw new ParentPaperValidationError("TOO_MANY_PAGES");
    for (const page of params.pages) {
        if (!isPaperPageImage(page.imageUrl)) throw new ParentPaperValidationError("INVALID_PAGE_IMAGE");
    }
    const title = params.title?.trim() || null;
    const paper = await db.parentPaper.create({
        data: {
            userId,
            learnerId: child.id,
            title,
            status: PARENT_PAPER_STATUS.pendingRecognition,
            pages: {
                create: params.pages.map((page, index) => ({
                    position: index,
                    imageUrl: page.imageUrl,
                })),
            },
        },
        include: {
            learner: { select: { name: true } },
            pages: { orderBy: { position: "asc" }, select: { id: true, position: true, imageUrl: true } },
        },
    });
    return { ...toSummary(paper), pages: paper.pages };
}
