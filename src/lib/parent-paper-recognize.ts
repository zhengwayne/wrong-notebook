/**
 * 家长试卷识别与确认：后台调用 vision 读卷，校验 bbox，家长确认后再写入孩子的学科错题本。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { startBackgroundTask, type BackgroundTaskHandle } from "@/lib/background-tasks";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { createLogger } from "@/lib/logger";
import { resolveNotebookForSubject } from "@/lib/notebook-resolver";
import {
    applyAnswerKeyToReview,
    effectiveVerdict,
    shouldImportVerdict,
    validateQuestionBBox,
    type ParentReviewQuestion,
} from "@/lib/parent-paper-review";
import {
    getParentPaper,
    isPaperPageImage,
    MAX_PARENT_ANSWER_KEY_IMAGES,
    PARENT_PAPER_STATUS,
    parseAnswerKeyImages,
    ParentPaperStateError,
    ParentPaperValidationError,
    type ParentPaperDetail,
} from "@/lib/parent-papers";
import { generateUniqueShortId } from "@/lib/short-id";

type Db = PrismaClient | Prisma.TransactionClient;

const logger = createLogger("parent-paper-recognize");

const inflightRecognitions = new Map<string, Promise<void>>();

/** 仅供测试：等待该试卷当前这次识别任务结束 */
export function waitForParentPaperRecognition(paperId: string): Promise<void> {
    return inflightRecognitions.get(paperId) ?? Promise.resolve();
}


const SUBJECT_NAMES: Record<string, string> = {
    math: "数学",
    physics: "物理",
    chemistry: "化学",
    biology: "生物",
    english: "英语",
    chinese: "语文",
    history: "历史",
    geography: "地理",
    politics: "政治",
};

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message.slice(0, 300) : "RECOGNITION_FAILED";
}

export async function failStaleRecognizingPapers(db: PrismaClient): Promise<number> {
    const result = await db.parentPaper.updateMany({
        where: { status: PARENT_PAPER_STATUS.recognizing },
        data: { status: PARENT_PAPER_STATUS.failed, errorMessage: "SERVER_RESTARTED" },
    });
    return result.count;
}

function normalizeAnswerKeyImages(images: string[] | undefined): string[] {
    const list = images ?? [];
    if (list.length > MAX_PARENT_ANSWER_KEY_IMAGES) throw new ParentPaperValidationError("TOO_MANY_ANSWER_KEY_IMAGES");
    for (const image of list) {
        if (!isPaperPageImage(image)) throw new ParentPaperValidationError("INVALID_ANSWER_KEY_IMAGE");
    }
    return list;
}

export async function startParentPaperRecognition(
    db: PrismaClient,
    userId: string,
    paperId: string,
    params: { answerKeyImages?: string[]; language?: "zh" | "en" } = {},
): Promise<{ paper: ParentPaperDetail; taskId: string } | null> {
    const existing = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: { pages: { select: { id: true } } },
    });
    if (!existing) return null;
    if (existing.status === PARENT_PAPER_STATUS.confirmed) throw new ParentPaperStateError("ALREADY_CONFIRMED");
    if (existing.status === PARENT_PAPER_STATUS.recognizing) throw new ParentPaperStateError("ALREADY_RECOGNIZING");
    if (!existing.pages.length) throw new ParentPaperValidationError("PAGES_REQUIRED");

    const incomingKeys = params.answerKeyImages != null ? normalizeAnswerKeyImages(params.answerKeyImages) : null;
    const answerKeyImages = incomingKeys ?? parseAnswerKeyImages(existing.answerKeyImages);
    const language = params.language === "en" ? "en" : "zh";

    await db.$transaction(async (tx) => {
        await tx.parentPaperQuestion.deleteMany({ where: { paperId } });
        await tx.parentPaper.update({
            where: { id: paperId },
            data: {
                status: PARENT_PAPER_STATUS.recognizing,
                errorMessage: null,
                recognizedAt: null,
                answerKeyImages: answerKeyImages.length ? JSON.stringify(answerKeyImages) : null,
                hasAnswerKey: answerKeyImages.length > 0,
            },
        });
    });

    const task = startBackgroundTask({
        userId,
        kind: "parent_paper",
        subject: existing.title,
        link: `/parent/papers/${paperId}`,
        total: existing.pages.length + (answerKeyImages.length ? 1 : 0),
    });

    const job = runParentPaperRecognition(db, userId, paperId, language, task);
    inflightRecognitions.set(paperId, job);
    void job.finally(() => {
        if (inflightRecognitions.get(paperId) === job) inflightRecognitions.delete(paperId);
    });

    const paper = await getParentPaper(db, userId, paperId);
    if (!paper) return null;
    return { paper, taskId: task.id };
}

async function runParentPaperRecognition(
    db: PrismaClient,
    userId: string,
    paperId: string,
    language: "zh" | "en",
    task: BackgroundTaskHandle,
): Promise<void> {
    try {
        const paper = await db.parentPaper.findFirst({
            where: { id: paperId, userId },
            include: { pages: { orderBy: { position: "asc" } } },
        });
        if (!paper) throw new Error("PAPER_NOT_FOUND");

        const pages = paper.pages.map((page) => splitDataUrl(page.imageUrl));
        const answerKeyImages = parseAnswerKeyImages(paper.answerKeyImages).map((image) => splitDataUrl(image));
        const ai = getAIService("vision");

        let keyQuestions: Array<{
            number: string;
            type?: "objective" | "subjective";
            answer: string;
            questionText?: string | null;
            knowledgePoints?: string[];
            maxScore?: number | null;
        }> = [];

        if (answerKeyImages.length) {
            task.setProgress(0, pages.length + 1);
            const key = await ai.readExamPaper({ mode: "answer_key", images: answerKeyImages, language });
            keyQuestions = key.questions;
            task.setProgress(1, pages.length + 1);
        }

        const review = await ai.readExamPaper({
            mode: "parent_review",
            images: pages,
            questions: keyQuestions.map((question) => ({
                number: question.number,
                type: question.type === "subjective" ? "subjective" : "objective",
                maxScore: question.maxScore ?? 1,
                answer: question.answer,
                questionText: question.questionText,
            })),
            language,
        });

        let questions: ParentReviewQuestion[] = (review.reviewQuestions ?? []).map((question) => ({
            ...question,
            bbox: validateQuestionBBox(question.bbox, pages.length),
        }));
        if (keyQuestions.length) questions = applyAnswerKeyToReview(questions, keyQuestions);

        await db.$transaction(async (tx) => {
            await tx.parentPaperQuestion.deleteMany({ where: { paperId } });
            if (questions.length) {
                await tx.parentPaperQuestion.createMany({
                    data: questions.map((question, index) => ({
                        paperId,
                        position: index,
                        number: question.number,
                        type: question.type,
                        questionText: question.questionText,
                        studentAnswer: question.studentAnswer,
                        correctAnswer: question.correctAnswer,
                        verdict: question.verdict,
                        confidence: question.confidence,
                        errorCause: question.errorCause,
                        knowledgePoints: JSON.stringify(question.knowledgePoints),
                        bbox: question.bbox ? JSON.stringify(question.bbox) : null,
                        subjectHint: question.subjectHint,
                        selected: shouldImportVerdict(question.verdict),
                    })),
                });
            }
            await tx.parentPaper.update({
                where: { id: paperId },
                data: {
                    status: PARENT_PAPER_STATUS.pendingConfirmation,
                    hasAnswerKey: keyQuestions.length > 0,
                    recognizedAt: new Date(),
                    errorMessage: null,
                },
            });
        });

        task.setProgress(pages.length + (answerKeyImages.length ? 1 : 0));
        task.succeed();
    } catch (error) {
        logger.error({ error, paperId }, "Parent paper recognition failed");
        try {
            await db.parentPaper.update({
                where: { id: paperId },
                data: { status: PARENT_PAPER_STATUS.failed, errorMessage: errorMessage(error) },
            });
        } catch (updateError) {
            logger.error({ error: updateError, paperId }, "Failed to mark parent paper as failed");
        }
        task.fail(error);
    }
}

async function resolveTags(tx: Prisma.TransactionClient, userId: string, names: string[], subjectKey: string) {
    const ids: { id: string }[] = [];
    for (const name of names) {
        const trimmed = name.trim();
        if (!trimmed) continue;
        const existing = await tx.knowledgeTag.findFirst({
            where: { name: trimmed, OR: [{ isSystem: true }, { userId }] },
            select: { id: true },
        });
        const tag = existing || await tx.knowledgeTag.create({
            data: { name: trimmed, subject: subjectKey, isSystem: false, userId },
            select: { id: true },
        });
        ids.push({ id: tag.id });
    }
    return ids;
}

export function subjectNameForPaper(title: string | null, subjectHint: string | null): string {
    const raw = (subjectHint || title || "").trim();
    const key = inferSubjectFromName(raw);
    if (key && SUBJECT_NAMES[key]) return SUBJECT_NAMES[key];
    if (subjectHint?.trim()) return subjectHint.trim();
    return "其他";
}

export async function updateParentPaperQuestion(
    db: Db,
    userId: string,
    paperId: string,
    questionId: string,
    patch: { overrideVerdict?: "correct" | "wrong" | "partial" | null; selected?: boolean },
): Promise<ParentPaperDetail | null> {
    const paper = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: { questions: { where: { id: questionId }, select: { id: true } } },
    });
    if (!paper) return null;
    if (paper.status === PARENT_PAPER_STATUS.confirmed) throw new ParentPaperStateError("ALREADY_CONFIRMED");
    if (paper.status !== PARENT_PAPER_STATUS.pendingConfirmation) throw new ParentPaperStateError("NOT_READY");
    if (!paper.questions.length) throw new ParentPaperValidationError("QUESTION_NOT_FOUND");

    await db.parentPaperQuestion.update({
        where: { id: questionId },
        data: {
            ...(patch.overrideVerdict !== undefined ? { overrideVerdict: patch.overrideVerdict } : {}),
            ...(patch.selected !== undefined ? { selected: patch.selected } : {}),
        },
    });
    return getParentPaper(db, userId, paperId);
}

export async function confirmParentPaper(
    db: PrismaClient,
    userId: string,
    paperId: string,
    params: { questionIds?: string[]; language?: "zh" | "en" } = {},
): Promise<{ importedCount: number; paper: ParentPaperDetail } | null> {
    const paper = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: {
            pages: { orderBy: { position: "asc" } },
            questions: { orderBy: { position: "asc" } },
        },
    });
    if (!paper) return null;
    if (paper.status === PARENT_PAPER_STATUS.confirmed) throw new ParentPaperStateError("ALREADY_CONFIRMED");
    if (paper.status !== PARENT_PAPER_STATUS.pendingConfirmation) throw new ParentPaperStateError("NOT_READY");

    const requested = params.questionIds ? new Set(params.questionIds) : null;
    const toImport = paper.questions.filter((question) => {
        if (question.importedErrorItemId) return false;
        if (requested) return requested.has(question.id);
        return question.selected;
    }).filter((question) => shouldImportVerdict(effectiveVerdict(question.verdict, question.overrideVerdict)));

    const importedCount = await db.$transaction(async (tx) => {
        let count = 0;
        for (const question of toImport) {
            const subjectName = subjectNameForPaper(paper.title, question.subjectHint);
            const notebook = await resolveNotebookForSubject(userId, subjectName, tx);
            const subjectKey = inferSubjectFromName(subjectName) || "other";
            const knowledgePoints = (() => {
                try {
                    const parsed = JSON.parse(question.knowledgePoints);
                    return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : [];
                } catch {
                    return [];
                }
            })();
            const tags = await resolveTags(tx, userId, knowledgePoints, subjectKey);
            const bbox = question.bbox ? (() => {
                try { return JSON.parse(question.bbox!) as { pageIndex?: number }; } catch { return null; }
            })() : null;
            const page = paper.pages[bbox?.pageIndex ?? 0] || paper.pages[0] || null;
            const title = paper.title || "家长上传卷子";
            const item = await tx.errorItem.create({
                data: {
                    shortId: await generateUniqueShortId(tx),
                    userId,
                    learnerId: paper.learnerId,
                    subjectId: notebook.id,
                    originalImageUrl: page?.imageUrl || "",
                    questionText: question.questionText || `${title} 第 ${question.number} 题`,
                    answerText: question.correctAnswer || null,
                    wrongAnswerText: question.studentAnswer || null,
                    mistakeAnalysis: question.errorCause || null,
                    mistakeStatus: question.studentAnswer.trim() ? "wrong_attempt" : "not_attempted",
                    knowledgePoints: JSON.stringify(knowledgePoints),
                    source: title,
                    masteryLevel: 0,
                    tags: { connect: tags },
                },
                select: { id: true },
            });
            await tx.parentPaperQuestion.update({
                where: { id: question.id },
                data: { importedErrorItemId: item.id, selected: true },
            });
            count += 1;
        }
        await tx.parentPaper.update({
            where: { id: paperId },
            data: { status: PARENT_PAPER_STATUS.confirmed, confirmedAt: new Date() },
        });
        return count;
    });

    if (importedCount > 0) {
        scheduleLearningPathReplan(userId, params.language === "en" ? "en" : "zh", paper.learnerId);
    }

    const updated = await getParentPaper(db, userId, paperId);
    if (!updated) return null;
    return { importedCount, paper: updated };
}
