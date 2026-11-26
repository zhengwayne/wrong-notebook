/**
 * 家长为当前孩子上传的试卷：保存页图片，识别后待家长确认，确认前不写入错题本。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getOwnedChildLearner, LearnerNotFoundError } from "@/lib/learners";
import { isNotebookSubject, NOTEBOOK_SUBJECTS, type NotebookSubject } from "@/lib/notebook-scope";
import { effectiveVerdict, type ParentReviewVerdict, type QuestionBBox } from "@/lib/parent-paper-review";
import { groupImportedNotebooks, type ImportedNotebookCount } from "@/lib/parent-paper-summary";

type Db = PrismaClient | Prisma.TransactionClient;

export const PARENT_PAPER_STATUS = {
    pendingRecognition: "pending_recognition",
    recognizing: "recognizing",
    pendingConfirmation: "pending_confirmation",
    confirmed: "confirmed",
    failed: "failed",
} as const;

export type ParentPaperStatus = (typeof PARENT_PAPER_STATUS)[keyof typeof PARENT_PAPER_STATUS];

export const MAX_PARENT_PAPER_PAGES = 20;
export const MAX_PARENT_PAGE_IMAGE_CHARS = 3 * 1024 * 1024;
export const MAX_PARENT_ANSWER_KEY_IMAGES = 20;

/** 家长上传卷子时可选的学科，与错题本学科列表一致（含语文）。 */
export const parentPaperSubjectKeySchema = z.enum(NOTEBOOK_SUBJECTS);

export class ParentPaperValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParentPaperValidationError";
    }
}

export class ParentPaperStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParentPaperStateError";
    }
}

const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i;

export function isPaperPageImage(value: string): boolean {
    return IMAGE_DATA_URL.test(value) && value.length <= MAX_PARENT_PAGE_IMAGE_CHARS;
}

export interface ParentPaperPageInput {
    imageUrl: string;
    originalImageUrl?: string | null;
}

export interface ParentPaperQuestionView {
    id: string;
    position: number;
    number: string;
    type: "objective" | "subjective";
    questionText: string;
    studentAnswer: string;
    correctAnswer: string;
    verdict: ParentReviewVerdict;
    overrideVerdict: ParentReviewVerdict | null;
    effectiveVerdict: ParentReviewVerdict;
    confidence: number;
    errorCause: string | null;
    knowledgePoints: string[];
    bbox: QuestionBBox | null;
    subjectHint: string | null;
    importedErrorItemId: string | null;
    selected: boolean;
}

export interface ParentPaperSummary {
    id: string;
    learnerId: string;
    learnerName: string;
    title: string | null;
    subjectKey: NotebookSubject | null;
    status: string;
    pageCount: number;
    questionCount: number;
    hasAnswerKey: boolean;
    version?: number;
    errorMessage: string | null;
    /** 仅在有答案卷时给出答对题数；没有答案卷时为 null，界面不展示分数 */
    correctCount: number | null;
    recognizedAt: Date | null;
    confirmedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ParentPaperDetail extends ParentPaperSummary {
    answerKeyImageCount: number;
    pages: Array<{ id: string; position: number; imageUrl: string }>;
    questions: ParentPaperQuestionView[];
    importedNotebooks: ImportedNotebookCount[];
}

function parseKnowledgePoints(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

function parseBbox(value: string | null | undefined): QuestionBBox | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as QuestionBBox;
        if (
            parsed && typeof parsed === "object"
            && Number.isInteger(parsed.pageIndex)
            && typeof parsed.x === "number"
            && typeof parsed.y === "number"
            && typeof parsed.width === "number"
            && typeof parsed.height === "number"
        ) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 小程序等移动端在 URL 上带 ?images=0：响应里不返回整页图片 data URL。
 * 判定页只看文字，每改一次判定都会拿到整份试卷详情，不带图可省下每次几 MB 的下载；默认（网页端）不变。
 */
export function wantsPageImages(req: Request): boolean {
    return new URL(req.url).searchParams.get("images") !== "0";
}

export function omitPageImages<T extends { pages: Array<{ imageUrl: string }> }>(paper: T): T {
    return { ...paper, pages: paper.pages.map((page) => ({ ...page, imageUrl: "" })) };
}

export function parseAnswerKeyImages(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

export function toQuestionView(question: {
    id: string;
    position: number;
    number: string;
    type: string;
    questionText: string;
    studentAnswer: string;
    correctAnswer: string;
    verdict: string;
    overrideVerdict: string | null;
    confidence: number;
    errorCause: string | null;
    knowledgePoints: string;
    bbox: string | null;
    subjectHint: string | null;
    importedErrorItemId: string | null;
    selected: boolean;
}): ParentPaperQuestionView {
    const verdict = effectiveVerdict(question.verdict);
    const override = question.overrideVerdict
        ? effectiveVerdict(question.overrideVerdict, question.overrideVerdict)
        : null;
    return {
        id: question.id,
        position: question.position,
        number: question.number,
        type: question.type === "subjective" ? "subjective" : "objective",
        questionText: question.questionText,
        studentAnswer: question.studentAnswer,
        correctAnswer: question.correctAnswer,
        verdict,
        overrideVerdict: override,
        effectiveVerdict: effectiveVerdict(question.verdict, question.overrideVerdict),
        confidence: question.confidence,
        errorCause: question.errorCause,
        knowledgePoints: parseKnowledgePoints(question.knowledgePoints),
        bbox: parseBbox(question.bbox),
        subjectHint: question.subjectHint,
        importedErrorItemId: question.importedErrorItemId,
        selected: question.selected,
    };
}

function toSummary(paper: {
    id: string;
    learnerId: string;
    title: string | null;
    subjectKey?: string | null;
    status: string;
    version?: number;
    hasAnswerKey?: boolean;
    errorMessage?: string | null;
    recognizedAt?: Date | null;
    confirmedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    learner: { name: string };
    pages: Array<{ id: string }>;
    questions?: Array<{ verdict: string; overrideVerdict: string | null }>;
}): ParentPaperSummary {
    const questions = paper.questions ?? [];
    const correctCount = questions.filter((question) => effectiveVerdict(question.verdict, question.overrideVerdict) === "correct").length;
    return {
        id: paper.id,
        learnerId: paper.learnerId,
        learnerName: paper.learner.name,
        title: paper.title,
        subjectKey: isNotebookSubject(paper.subjectKey) ? paper.subjectKey : null,
        status: paper.status,
        pageCount: paper.pages.length,
        questionCount: questions.length,
        hasAnswerKey: Boolean(paper.hasAnswerKey),
        version: paper.version ?? 0,
        errorMessage: paper.errorMessage ?? null,
        correctCount: paper.hasAnswerKey ? correctCount : null,
        recognizedAt: paper.recognizedAt ?? null,
        confirmedAt: paper.confirmedAt ?? null,
        createdAt: paper.createdAt,
        updatedAt: paper.updatedAt,
    };
}


async function loadImportedNotebooks(
    db: Db,
    questions: Array<{ importedErrorItemId: string | null }>,
): Promise<ImportedNotebookCount[]> {
    const ids = questions.map((question) => question.importedErrorItemId).filter((id): id is string => Boolean(id));
    if (!ids.length) return [];
    const items = await db.errorItem.findMany({
        where: { id: { in: ids } },
        select: { subjectId: true, subject: { select: { name: true } } },
    });
    return groupImportedNotebooks(items.flatMap((item) => {
        if (!item.subjectId) return [];
        return [{ subjectId: item.subjectId, subjectName: item.subject?.name || item.subjectId }];
    }));
}

const paperInclude = {
    learner: { select: { name: true } },
    pages: { orderBy: { position: "asc" as const }, select: { id: true, position: true, imageUrl: true } },
    questions: { orderBy: { position: "asc" as const } },
};

export async function listParentPapers(db: Db, userId: string, learnerId: string): Promise<ParentPaperSummary[]> {
    const child = await getOwnedChildLearner(db, userId, learnerId);
    if (!child) throw new LearnerNotFoundError();
    const papers = await db.parentPaper.findMany({
        where: { userId, learnerId },
        include: {
            learner: { select: { name: true } },
            pages: { select: { id: true } },
            questions: { select: { verdict: true, overrideVerdict: true } },
        },
        orderBy: { createdAt: "desc" },
    });
    return papers.map(toSummary);
}

export async function getParentPaper(db: Db, userId: string, paperId: string): Promise<ParentPaperDetail | null> {
    const paper = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: paperInclude,
    });
    if (!paper) return null;
    return {
        ...toSummary(paper),
        answerKeyImageCount: parseAnswerKeyImages(paper.answerKeyImages).length,
        pages: paper.pages,
        questions: paper.questions.map(toQuestionView),
        importedNotebooks: await loadImportedNotebooks(db, paper.questions),
    };
}

export async function createParentPaper(
    db: Db,
    userId: string,
    params: { learnerId: string; title?: string | null; subjectKey?: string | null; pages: ParentPaperPageInput[]; answerKeyImages?: string[] },
): Promise<ParentPaperDetail> {
    const child = await getOwnedChildLearner(db, userId, params.learnerId);
    if (!child) throw new LearnerNotFoundError();
    if (!params.pages.length) throw new ParentPaperValidationError("PAGES_REQUIRED");
    if (params.pages.length > MAX_PARENT_PAPER_PAGES) throw new ParentPaperValidationError("TOO_MANY_PAGES");
    for (const page of params.pages) {
        if (!isPaperPageImage(page.imageUrl)) throw new ParentPaperValidationError("INVALID_PAGE_IMAGE");
    }
    const answerKeyImages = params.answerKeyImages ?? [];
    if (answerKeyImages.length > MAX_PARENT_ANSWER_KEY_IMAGES) throw new ParentPaperValidationError("TOO_MANY_ANSWER_KEY_IMAGES");
    for (const image of answerKeyImages) {
        if (!isPaperPageImage(image)) throw new ParentPaperValidationError("INVALID_ANSWER_KEY_IMAGE");
    }
    const title = params.title?.trim() || null;
    const subjectKey = isNotebookSubject(params.subjectKey) ? params.subjectKey : null;
    const paper = await db.parentPaper.create({
        data: {
            userId,
            learnerId: child.id,
            title,
            subjectKey,
            status: PARENT_PAPER_STATUS.pendingRecognition,
            answerKeyImages: answerKeyImages.length ? JSON.stringify(answerKeyImages) : null,
            hasAnswerKey: answerKeyImages.length > 0,
            pages: {
                create: params.pages.map((page, index) => ({
                    position: index,
                    imageUrl: page.imageUrl,
                    originalImageUrl: page.originalImageUrl || null,
                })),
            },
        },
        include: paperInclude,
    });
    return {
        ...toSummary(paper),
        answerKeyImageCount: answerKeyImages.length,
        pages: paper.pages,
        questions: paper.questions.map(toQuestionView),
        importedNotebooks: [],
    };
}
