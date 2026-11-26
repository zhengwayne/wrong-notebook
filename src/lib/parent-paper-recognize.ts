/**
 * 家长试卷识别与确认：后台调用 vision 读卷，校验 bbox，家长确认后再写入孩子的学科错题本。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { getAIService } from "@/lib/ai";
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { recordAiProvenance } from "@/lib/ai/provenance";
import { ImageValidationError, normalizeImageDataUrl } from "@/lib/server/image-normalize";
import { uprightImageDataUrl } from "@/lib/server/page-orientation";
import { startBackgroundTask, type BackgroundTaskHandle } from "@/lib/background-tasks";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { isNotebookSubject, type NotebookSubject } from "@/lib/notebook-scope";
import { scheduleLearningPathReplan } from "@/lib/learning-path/service";
import { createLogger } from "@/lib/logger";
import { resolveNotebookForSubject } from "@/lib/notebook-resolver";
import { confirmAiReservation, releaseAiReservation } from "@/lib/ai-quota";
import { dominantSubject, inferSubjectFromContent } from "@/lib/subject-infer";
import {
    applyAnswerKeyToReview,
    effectiveVerdict,
    shouldImportVerdict,
    normalizeQuestionBBox,
    validateQuestionBBox,
    type ParentReviewQuestion,
    type QuestionBBox,
} from "@/lib/parent-paper-review";
import type { ImportedNotebookCount } from "@/lib/parent-paper-summary";
import { verifyParentPaperQuestions } from "@/lib/parent-paper-verify";
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
import { autoCropPaperImage } from "@/lib/parent-paper-autocrop";
import { layoutParentPaperBBoxes } from "@/lib/parent-paper-box-layout";
import { cropDataUrlRegion } from "@/lib/parent-paper-crop";
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

function parseStoredBbox(value: string | null): QuestionBBox | null {
    if (!value) return null;
    try {
        return validateQuestionBBox(JSON.parse(value), Number.MAX_SAFE_INTEGER);
    } catch {
        return null;
    }
}

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

async function normalizeAnswerKeyImages(images: string[] | undefined): Promise<string[]> {
    const list = images ?? [];
    if (list.length > MAX_PARENT_ANSWER_KEY_IMAGES) throw new ParentPaperValidationError("TOO_MANY_ANSWER_KEY_IMAGES");
    const result: string[] = [];
    for (const image of list) {
        if (!isPaperPageImage(image)) throw new ParentPaperValidationError("INVALID_ANSWER_KEY_IMAGE");
        try {
            result.push((await normalizeImageDataUrl(image)).dataUrl);
        } catch (err) {
            if (err instanceof ImageValidationError) throw new ParentPaperValidationError("INVALID_ANSWER_KEY_IMAGE");
            throw err;
        }
    }
    return result;
}


export async function ensurePagesAutoCropped(
    db: PrismaClient,
    pages: Array<{ id: string; position: number; imageUrl: string; originalImageUrl?: string | null }>,
): Promise<Array<{ id: string; position: number; imageUrl: string }>> {
    const prepared = [];
    for (const page of pages) {
        if (page.originalImageUrl) {
            // 已有 originalImageUrl 表示页面已完成初始转正或经家长手动旋转，不再重跑自动旋转以免覆盖
            prepared.push({ id: page.id, position: page.position, imageUrl: page.imageUrl });
            continue;
        }
        let cleanUrl = page.imageUrl;
        let normalized = false;
        try {
            cleanUrl = (await uprightImageDataUrl(page.imageUrl)).dataUrl;
            normalized = true;
        } catch {
            try {
                cleanUrl = (await normalizeImageDataUrl(page.imageUrl)).dataUrl;
                normalized = true;
            } catch {
                // 若是特殊 mock/内联历史数据，保留原样由后续裁切处理
            }
        }
        const result = await autoCropPaperImage(cleanUrl);
        const nextImage = result.cropped ? result.imageUrl : cleanUrl;
        if (normalized || nextImage !== page.imageUrl) {
            await db.parentPaperPage.update({
                where: { id: page.id },
                data: { originalImageUrl: cleanUrl, imageUrl: nextImage },
            });
        }
        prepared.push({ id: page.id, position: page.position, imageUrl: nextImage });
    }
    return prepared;
}

export async function startParentPaperRecognition(
    db: PrismaClient,
    userId: string,
    paperId: string,
    params: { answerKeyImages?: string[]; language?: "zh" | "en"; quotaReservationId?: string | null } = {},
): Promise<{ paper: ParentPaperDetail; taskId: string } | null> {
    const existing = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: { pages: { select: { id: true } } },
    });
    if (!existing) return null;
    if (existing.status === PARENT_PAPER_STATUS.confirmed) throw new ParentPaperStateError("ALREADY_CONFIRMED");
    if (existing.status === PARENT_PAPER_STATUS.recognizing) throw new ParentPaperStateError("ALREADY_RECOGNIZING");
    if (!existing.pages.length) throw new ParentPaperValidationError("PAGES_REQUIRED");

    const incomingKeys = params.answerKeyImages != null ? await normalizeAnswerKeyImages(params.answerKeyImages) : null;
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

    const job = runParentPaperRecognition(db, userId, paperId, language, task, params.quotaReservationId ?? null);
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
    quotaReservationId: string | null = null,
): Promise<void> {
    try {
        const paper = await db.parentPaper.findFirst({
            where: { id: paperId, userId },
            include: { pages: { orderBy: { position: "asc" } } },
        });
        if (!paper) throw new Error("PAPER_NOT_FOUND");

        const preparedPages = await ensurePagesAutoCropped(db, paper.pages);
        const pages = preparedPages.map((page) => splitDataUrl(page.imageUrl));
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
            subject: paper.subjectKey,
        });

        // 解析层只返回校验后的原始框；这里是唯一一次外扩边距的地方
        let questions: ParentReviewQuestion[] = (review.reviewQuestions ?? []).map((question) => ({
            ...question,
            bbox: normalizeQuestionBBox(question.bbox, pages.length),
        }));
        if (keyQuestions.length) questions = applyAnswerKeyToReview(questions, keyQuestions);
        questions = layoutParentPaperBBoxes(questions);
        try {
            questions = await verifyParentPaperQuestions(questions, { language, subject: paper.subjectKey });
        } catch (error) {
            logger.warn({ error, paperId }, "Parent paper verification skipped");
        }
        const provenanceId = await recordAiProvenance(db, { task: "exam-read", role: "vision" });
        // 没选学科时：识别没给学科的题按内容推断，推断不出按整卷主学科
        const recognizedFallback = isNotebookSubject(paper.subjectKey) ? null : paperDominantSubject(questions);
        const hintFor = (question: ParentReviewQuestion): string | null => {
            if (question.subjectHint && inferSubjectFromName(question.subjectHint)) return question.subjectHint;
            if (isNotebookSubject(paper.subjectKey)) return SUBJECT_NAMES[paper.subjectKey];
            const inferred = inferSubjectFromContent(questionSubjectText(question)) ?? recognizedFallback;
            return inferred ? SUBJECT_NAMES[inferred] : question.subjectHint || null;
        };

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
                        subjectHint: hintFor(question),
                        provenanceId,
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
        // 整份卷子算一次：认出至少 1 道题才确认，一道都没认出则退回
        if (quotaReservationId) {
            if (questions.length > 0) await confirmAiReservation(quotaReservationId);
            else await releaseAiReservation(quotaReservationId);
        }
    } catch (error) {
        logger.error({ error, paperId }, "Parent paper recognition failed");
        if (quotaReservationId) await releaseAiReservation(quotaReservationId);
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
            where: { name: trimmed, subject: subjectKey, OR: [{ isSystem: true }, { userId }] },
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

/**
 * 卷子题目放进哪个错题本：选了学科按学科；否则按识别给的学科、卷名；
 * 都判断不出时按题目内容推断（content），再退到整份卷子的主学科（paperFallback），最后才是「其他」。
 */
export function subjectNameForPaper(
    title: string | null,
    subjectHint: string | null,
    subjectKey?: string | null,
    options: { content?: string | null; paperFallback?: NotebookSubject | null } = {},
): string {
    if (isNotebookSubject(subjectKey) && SUBJECT_NAMES[subjectKey]) return SUBJECT_NAMES[subjectKey];
    const fromHint = inferSubjectFromName((subjectHint || "").trim());
    if (fromHint && SUBJECT_NAMES[fromHint]) return SUBJECT_NAMES[fromHint];
    const fromTitle = inferSubjectFromName((title || "").trim());
    if (fromTitle && SUBJECT_NAMES[fromTitle]) return SUBJECT_NAMES[fromTitle];
    const fromContent = inferSubjectFromContent(options.content) ?? options.paperFallback ?? null;
    if (fromContent && SUBJECT_NAMES[fromContent]) return SUBJECT_NAMES[fromContent];
    const hint = subjectHint?.trim();
    if (hint && hint !== "其他") return hint;
    return "其他";
}

/** 题目内容用于推断学科的文字 */
function questionSubjectText(question: { questionText?: string | null; correctAnswer?: string | null; studentAnswer?: string | null }): string {
    return [question.questionText, question.correctAnswer, question.studentAnswer].filter(Boolean).join(" ");
}

/** 整份卷子的主学科：逐题按识别学科或内容推断后取最多的 */
export function paperDominantSubject(questions: Array<{ subjectHint?: string | null; questionText?: string | null; correctAnswer?: string | null; studentAnswer?: string | null }>): NotebookSubject | null {
    return dominantSubject(questions.map((question) => {
        const fromHint = inferSubjectFromName((question.subjectHint || "").trim());
        if (isNotebookSubject(fromHint)) return fromHint;
        return inferSubjectFromContent(questionSubjectText(question));
    }));
}

export async function updateParentPaperQuestion(
    db: Db,
    userId: string,
    paperId: string,
    questionId: string,
    patch: { overrideVerdict?: "correct" | "wrong" | "partial" | null; selected?: boolean; bbox?: QuestionBBox | null },
): Promise<ParentPaperDetail | null> {
    const paper = await db.parentPaper.findFirst({
        where: { id: paperId, userId },
        include: {
            questions: { where: { id: questionId }, select: { id: true } },
            pages: { select: { id: true } },
        },
    });
    if (!paper) return null;
    if (paper.status === PARENT_PAPER_STATUS.confirmed) throw new ParentPaperStateError("ALREADY_CONFIRMED");
    if (paper.status !== PARENT_PAPER_STATUS.pendingConfirmation) throw new ParentPaperStateError("NOT_READY");
    if (!paper.questions.length) throw new ParentPaperValidationError("QUESTION_NOT_FOUND");

    let nextBbox: string | null | undefined;
    if (patch.bbox !== undefined) {
        if (patch.bbox === null) nextBbox = null;
        else {
            const validated = validateQuestionBBox({ ...patch.bbox, pageIndex: patch.bbox.pageIndex }, paper.pages.length);
            if (!validated) throw new ParentPaperValidationError("INVALID_BBOX");
            nextBbox = JSON.stringify(validated);
        }
    }

    const applyUpdate = async (tx: Prisma.TransactionClient | Db) => {
        await tx.parentPaperQuestion.update({
            where: { id: questionId },
            data: {
                ...(patch.overrideVerdict !== undefined ? { overrideVerdict: patch.overrideVerdict } : {}),
                ...(patch.selected !== undefined ? { selected: patch.selected } : {}),
                ...(nextBbox !== undefined ? { bbox: nextBbox } : {}),
            },
        });
        await tx.parentPaper.update({
            where: { id: paperId },
            data: { version: { increment: 1 } },
        });
    };

    if ("$transaction" in db && typeof db.$transaction === "function") {
        await db.$transaction(async (tx) => applyUpdate(tx));
    } else {
        await applyUpdate(db);
    }
    return getParentPaper(db, userId, paperId);
}

export async function confirmParentPaper(
    db: PrismaClient,
    userId: string,
    paperId: string,
    params: { questionIds?: string[]; language?: "zh" | "en"; expectedVersion?: number } = {},
): Promise<{ importedCount: number; importedNotebooks: ImportedNotebookCount[]; replanned: boolean; paper: ParentPaperDetail } | null> {
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

    const snapshotVersion = paper.version;
    if (params.expectedVersion !== undefined && params.expectedVersion !== snapshotVersion) {
        throw new ParentPaperStateError("VERSION_CONFLICT");
    }

    const requested = params.questionIds ? new Set(params.questionIds) : null;
    const toImport = paper.questions.filter((question) => {
        if (question.importedErrorItemId) return false;
        if (requested) return requested.has(question.id);
        return question.selected;
    }).filter((question) => shouldImportVerdict(effectiveVerdict(question.verdict, question.overrideVerdict)));

    // 耗时的图片裁剪放在数据库事务外执行，避免阻塞 SQLite 写入事务
    const crops = new Map<string, string>();
    for (const question of toImport) {
        const bbox = parseStoredBbox(question.bbox);
        const page = paper.pages[bbox?.pageIndex ?? 0] || paper.pages[0] || null;
        if (!page) continue;
        if (bbox) {
            const cropped = await cropDataUrlRegion(page.imageUrl, bbox);
            crops.set(question.id, cropped.imageUrl);
        } else {
            crops.set(question.id, page.imageUrl);
        }
    }

    const txResult = await db.$transaction(async (tx) => {
        // 先用 status + version CAS 条件更新抢占确认所有权，拒绝并发覆盖与过期快照
        const claimed = await tx.parentPaper.updateMany({
            where: {
                id: paperId,
                userId,
                status: PARENT_PAPER_STATUS.pendingConfirmation,
                version: snapshotVersion,
            },
            data: {
                status: PARENT_PAPER_STATUS.confirmed,
                confirmedAt: new Date(),
                version: { increment: 1 },
            },
        });
        if (claimed.count === 0) {
            const latest = await tx.parentPaper.findFirst({
                where: { id: paperId, userId },
                select: { status: true },
            });
            if (!latest) return null;
            if (latest.status === PARENT_PAPER_STATUS.confirmed) throw new ParentPaperStateError("ALREADY_CONFIRMED");
            if (latest.status !== PARENT_PAPER_STATUS.pendingConfirmation) throw new ParentPaperStateError("NOT_READY");
            throw new ParentPaperStateError("VERSION_CONFLICT");
        }

        let count = 0;
        const paperFallback = isNotebookSubject(paper.subjectKey) ? null : paperDominantSubject(toImport);
        for (const question of toImport) {
            const existingImport = await tx.sourceImport.findUnique({
                where: {
                    userId_sourceKind_sourceQuestionId: {
                        userId,
                        sourceKind: "parent_paper",
                        sourceQuestionId: question.id,
                    },
                },
                select: { errorItemId: true },
            });
            if (existingImport) {
                await tx.parentPaperQuestion.update({
                    where: { id: question.id },
                    data: { importedErrorItemId: existingImport.errorItemId, selected: true },
                });
                continue;
            }

            const subjectName = subjectNameForPaper(paper.title, question.subjectHint, paper.subjectKey, {
                content: questionSubjectText(question),
                paperFallback,
            });
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
            const title = paper.title || "家长上传卷子";
            const item = await tx.errorItem.create({
                data: {
                    shortId: await generateUniqueShortId(tx),
                    userId,
                    learnerId: paper.learnerId,
                    subjectId: notebook.id,
                    originalImageUrl: crops.get(question.id) || "",
                    questionText: question.questionText || `${title} 第 ${question.number} 题`,
                    answerText: question.correctAnswer || null,
                    wrongAnswerText: question.studentAnswer || null,
                    mistakeAnalysis: question.errorCause || null,
                    mistakeStatus: question.studentAnswer.trim() ? "wrong_attempt" : "not_attempted",
                    knowledgePoints: JSON.stringify(knowledgePoints),
                    source: title,
                    provenanceId: question.provenanceId ?? null,
                    masteryLevel: 0,
                    tags: { connect: tags },
                },
                select: { id: true },
            });
            await tx.sourceImport.create({
                data: {
                    userId,
                    sourceKind: "parent_paper",
                    sourceId: paperId,
                    sourceQuestionId: question.id,
                    errorItemId: item.id,
                },
            });
            await tx.parentPaperQuestion.update({
                where: { id: question.id },
                data: { importedErrorItemId: item.id, selected: true },
            });
            count += 1;
        }
        return count;
    });

    if (txResult === null) return null;
    const importedCount = txResult;

    if (importedCount > 0) {
        scheduleLearningPathReplan(userId, params.language === "en" ? "en" : "zh", paper.learnerId);
    }

    const updated = await getParentPaper(db, userId, paperId);
    if (!updated) return null;
    return {
        importedCount,
        importedNotebooks: updated.importedNotebooks,
        replanned: importedCount > 0,
        paper: updated,
    };
}
