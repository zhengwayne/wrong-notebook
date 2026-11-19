/**
 * 家长试卷识别：解析 parent_review 模式的模型输出，校验并规范化每题 bbox。
 * 本阶段只存储坐标，不在界面上绘制。
 */
import { z } from "zod";
import { extractJsonObject } from "@/lib/ai/schema";
import { compareObjective } from "@/lib/grading";

export const PARENT_REVIEW_VERDICTS = ["correct", "wrong", "partial"] as const;
export type ParentReviewVerdict = (typeof PARENT_REVIEW_VERDICTS)[number];

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export interface QuestionBBox {
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ParentReviewQuestion {
    number: string;
    type: "objective" | "subjective";
    questionText: string;
    studentAnswer: string;
    correctAnswer: string;
    verdict: ParentReviewVerdict;
    confidence: number;
    errorCause: string | null;
    knowledgePoints: string[];
    subjectHint: string | null;
    bbox: QuestionBBox | null;
}

export interface ParentPaperReviewResult {
    questions: ParentReviewQuestion[];
}

const optionalText = z.union([z.string(), z.number(), z.null()]).optional()
    .transform((value) => (value === null || value === undefined ? "" : String(value))).catch("");

const optionalNullableText = z.union([z.string(), z.number(), z.null()]).optional()
    .transform((value) => {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        return text ? text : null;
    }).catch(null);

const toConfidence = z.preprocess((value) => {
    if (value === null || value === undefined || value === "") return 0;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) return 0;
    if (num > 1 && num <= 100) return num / 100;
    return num;
}, z.number().min(0).max(1)).catch(0);

const BBoxSchema = z.object({
    pageIndex: z.union([z.number(), z.string()]).optional(),
    page: z.union([z.number(), z.string()]).optional(),
    x: z.union([z.number(), z.string()]).optional(),
    y: z.union([z.number(), z.string()]).optional(),
    width: z.union([z.number(), z.string()]).optional(),
    w: z.union([z.number(), z.string()]).optional(),
    height: z.union([z.number(), z.string()]).optional(),
    h: z.union([z.number(), z.string()]).optional(),
}).passthrough();

const ReviewQuestionSchema = z.object({
    number: z.union([z.string(), z.number()]).transform((value) => String(value).trim()),
    type: z.enum(["objective", "subjective"]).catch("objective").optional(),
    questionText: optionalText,
    studentAnswer: optionalText,
    correctAnswer: optionalText,
    answer: optionalText, // 兼容误把正确答案写在 answer
    verdict: z.enum(PARENT_REVIEW_VERDICTS).catch("wrong"),
    confidence: toConfidence.optional(),
    errorCause: optionalNullableText,
    knowledgePoints: z.array(z.union([z.string(), z.number()])).catch([]).optional(),
    subject: optionalNullableText,
    subjectHint: optionalNullableText,
    bbox: z.union([BBoxSchema, z.null()]).optional().catch(null),
});

const ReviewSchema = z.object({
    questions: z.array(ReviewQuestionSchema).max(200).default([]),
});

function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }
    return null;
}

/**
 * 校验并规范化模型给出的 bbox。
 * 接受已经是 0–1 的比例，或 0–100 的百分数；像素坐标、缺页、过小或越界的框丢弃为 null。
 */
export function validateQuestionBBox(raw: unknown, pageCount: number): QuestionBBox | null {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const pageRaw = toFiniteNumber(record.pageIndex ?? record.page);
    const xRaw = toFiniteNumber(record.x);
    const yRaw = toFiniteNumber(record.y);
    const wRaw = toFiniteNumber(record.width ?? record.w);
    const hRaw = toFiniteNumber(record.height ?? record.h);
    if (pageRaw == null || xRaw == null || yRaw == null || wRaw == null || hRaw == null) return null;

    const pageIndex = Math.trunc(pageRaw);
    if (pageIndex < 0 || pageIndex >= pageCount) return null;
    if (wRaw <= 0 || hRaw <= 0) return null;

    const values = [xRaw, yRaw, wRaw, hRaw];
    const max = Math.max(...values);
    let scale = 1;
    if (max > 1.05 && max <= 100) scale = 100;
    else if (max > 100) return null; // 像素或其他未知坐标系

    let x = xRaw / scale;
    let y = yRaw / scale;
    let width = wRaw / scale;
    let height = hRaw / scale;

    if (width < 0) { x += width; width = Math.abs(width); }
    if (height < 0) { y += height; height = Math.abs(height); }

    return clampNormalizedBBox({ pageIndex, x, y, width, height });
}

/** 把矩形限制在页面内；过小的框丢弃为 null */
export function clampNormalizedBBox(bbox: QuestionBBox): QuestionBBox | null {
    const pageIndex = bbox.pageIndex;
    let { x, y, width, height } = bbox;
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
    if (width < 0) { x += width; width = Math.abs(width); }
    if (height < 0) { y += height; height = Math.abs(height); }
    const x2 = Math.min(1, Math.max(0, x + width));
    const y2 = Math.min(1, Math.max(0, y + height));
    const x1 = Math.min(1, Math.max(0, x));
    const y1 = Math.min(1, Math.max(0, y));
    x = x1;
    y = y1;
    width = x2 - x1;
    height = y2 - y1;
    if (width < 0.01 || height < 0.01) return null;
    return {
        pageIndex,
        x: Number(x.toFixed(4)),
        y: Number(y.toFixed(4)),
        width: Number(width.toFixed(4)),
        height: Number(height.toFixed(4)),
    };
}

/** 模型框只做很小的外扩，不再拉满整行或抬高最小宽高，以免相邻题重叠。 */
export const BBOX_PAD_X = 0.012;
export const BBOX_PAD_Y = 0.01;

export function expandQuestionBBox(bbox: QuestionBBox): QuestionBBox {
    const padded = clampNormalizedBBox({
        pageIndex: bbox.pageIndex,
        x: bbox.x - BBOX_PAD_X,
        y: bbox.y - BBOX_PAD_Y,
        width: bbox.width + BBOX_PAD_X * 2,
        height: bbox.height + BBOX_PAD_Y * 2,
    });
    return padded ?? bbox;
}

/**
 * 校验后再外扩。整条识卷流水线只在 parent-paper-recognize 里调用一次；
 * 解析模型输出（parseParentPaperReview）和家长手动画的框都只用 validateQuestionBBox，不要再次外扩。
 */
export function normalizeQuestionBBox(raw: unknown, pageCount: number): QuestionBBox | null {
    const validated = validateQuestionBBox(raw, pageCount);
    return validated ? expandQuestionBBox(validated) : null;
}

export function parseParentPaperReview(text: string, pageCount: number): ParentPaperReviewResult {
    const parsed = ReviewSchema.parse(extractJsonObject(text));
    const questions: ParentReviewQuestion[] = [];
    for (const item of parsed.questions) {
        if (!item.number) continue;
        const correctAnswer = (item.correctAnswer || item.answer || "").trim();
        questions.push({
            number: item.number,
            type: item.type === "subjective" ? "subjective" : "objective",
            questionText: item.questionText.trim(),
            studentAnswer: item.studentAnswer.trim(),
            correctAnswer,
            verdict: item.verdict,
            confidence: item.confidence ?? 0,
            errorCause: item.errorCause,
            knowledgePoints: (item.knowledgePoints || []).map((point) => String(point).trim()).filter(Boolean).slice(0, 5),
            subjectHint: item.subjectHint || item.subject,
            // 解析层只校验并换算成 0-1 坐标，外扩统一在识卷流水线里做一次，避免题框被加两次边距
            bbox: validateQuestionBBox(item.bbox, pageCount),
        });
    }
    return { questions };
}

/** 有答案卷时，客观题以标准答案比对覆盖模型判定（不对整卷打分） */
export function applyAnswerKeyToReview(
    questions: ParentReviewQuestion[],
    keyQuestions: Array<{
        number: string;
        type?: string;
        answer: string;
        questionText?: string | null;
        knowledgePoints?: string[] | null;
    }>,
): ParentReviewQuestion[] {
    if (!keyQuestions.length) return questions;
    const byNumber = new Map(keyQuestions.map((item) => [item.number.trim(), item]));
    return questions.map((question) => {
        const key = byNumber.get(question.number);
        if (!key) return question;
        const correctAnswer = key.answer.trim() || question.correctAnswer;
        const knowledgePoints = question.knowledgePoints.length
            ? question.knowledgePoints
            : (key.knowledgePoints || []).map((point) => point.trim()).filter(Boolean);
        const questionText = question.questionText || (key.questionText || "").trim();
        const type = key.type === "subjective" ? "subjective" : "objective";
        if (type !== "objective") {
            return { ...question, type, correctAnswer, knowledgePoints, questionText };
        }
        const compared = compareObjective(question.studentAnswer, { answer: correctAnswer, acceptedAnswers: [] });
        const verdict: ParentReviewVerdict = compared === "correct" ? "correct" : "wrong";
        return {
            ...question,
            type,
            correctAnswer,
            knowledgePoints,
            questionText,
            verdict,
            confidence: Math.max(question.confidence, 0.9),
            errorCause: verdict === "correct" ? null : (question.errorCause || null),
        };
    });
}

export function effectiveVerdict(verdict: string, overrideVerdict?: string | null): ParentReviewVerdict {
    if (overrideVerdict === "correct" || overrideVerdict === "wrong" || overrideVerdict === "partial") return overrideVerdict;
    if (verdict === "correct" || verdict === "wrong" || verdict === "partial") return verdict;
    return "wrong";
}

export function isLowConfidence(confidence: number): boolean {
    return confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function shouldImportVerdict(verdict: ParentReviewVerdict): boolean {
    return verdict !== "correct";
}
