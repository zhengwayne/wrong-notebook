import { z } from "zod";
import { extractJsonObject } from "./schema";
import { parseParentPaperReview, validateQuestionBBox, type ParentReviewQuestion, type QuestionBBox } from "@/lib/parent-paper-review";

export type ExamPaperReadMode = 'answer_key' | 'student' | 'identify' | 'parent_review';

export const PROCESS_LEVELS = ['excellent', 'good', 'fair', 'needs_work'] as const;
export type ProcessLevel = typeof PROCESS_LEVELS[number];

export const VISUAL_ALERT_KINDS = ['heavy_erasure', 'messy_handwriting', 'missing_steps', 'large_blank'] as const;
export type VisualAlertKind = typeof VISUAL_ALERT_KINDS[number];

export interface PaperAppearanceAssessment {
    handwritingLevel: ProcessLevel | null;
    neatnessLevel: ProcessLevel | null;
    attitudeLevel: ProcessLevel | null;
    visualAlerts: VisualAlertKind[];
}

/** 读卷输入：答案卷识别或学生答卷识别，多页图片按顺序传入 */
export interface ExamPaperReadInput {
    /** answer_key 标准答案；student 学生答卷（含卷头身份）；identify 只读卷头的班级、学号、姓名（拍照时即时识别） */
    mode: ExamPaperReadMode;
    /** data URL 或纯 base64 */
    images: { base64: string; mimeType: string }[];
    /** 学生答卷模式下的题目清单（题号、题型、分值、标准答案） */
    questions?: { number: string; type: 'objective' | 'subjective'; maxScore: number; answer: string; questionText?: string | null }[];
    language?: 'zh' | 'en';
    /** 家长试卷学科（math / chinese 等），用于针对性提示词与核验 */
    subject?: string | null;
}

const toNumberOrNull = z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : null;
}, z.number().nullable());

const ReadQuestionSchema = z.object({
    number: z.union([z.string(), z.number()]).transform((value) => String(value).trim()),
    type: z.enum(['objective', 'subjective']).catch('objective').optional(),
    maxScore: toNumberOrNull.optional(),
    answer: z.union([z.string(), z.number(), z.null()]).transform((value) => value === null ? '' : String(value)).catch(''),
    score: toNumberOrNull.optional(),
    confidence: toNumberOrNull.optional(),
    bbox: z.unknown().optional(),
    reason: z.string().nullish().catch(null),
    questionText: z.string().nullish().catch(null),
    knowledgePoints: z.array(z.string()).catch([]).optional(),
});

const optionalText = z.union([z.string(), z.number(), z.null()]).optional()
    .transform((value) => (value === null || value === undefined ? null : String(value))).catch(null);

const processLevelField = z.preprocess(
    (v) => (typeof v === 'string' && (PROCESS_LEVELS as readonly string[]).includes(v) ? v : null),
    z.enum(PROCESS_LEVELS).nullable(),
).catch(null);

const PaperAppearanceSchema = z.object({
    handwritingLevel: processLevelField.optional().default(null),
    neatnessLevel: processLevelField.optional().default(null),
    attitudeLevel: processLevelField.optional().default(null),
    visualAlerts: z.array(z.unknown()).optional().default([]).transform((arr) =>
        arr.filter((item): item is VisualAlertKind =>
            typeof item === 'string' && (VISUAL_ALERT_KINDS as readonly string[]).includes(item),
        ),
    ),
}).nullish().catch(null);

const ExamPaperReadSchema = z.object({
    studentName: optionalText,
    className: optionalText,
    studentNo: optionalText,
    paperAppearance: PaperAppearanceSchema,
    questions: z.array(ReadQuestionSchema).max(200).default([]),
});

export interface ExamPaperReadQuestion {
    number: string;
    type?: 'objective' | 'subjective';
    maxScore?: number | null;
    answer: string;
    score?: number | null;
    confidence?: number | null;
    bbox?: QuestionBBox | null;
    reason?: string | null;
    questionText?: string | null;
    knowledgePoints?: string[];
}

export interface ExamPaperReadResult {
    studentName: string | null;
    /** 卷头手写的班级，如 "七年级3班" */
    className: string | null;
    /** 卷头手写的学号 */
    studentNo: string | null;
    /** 卷面书写工整度、整洁度、学习态度及宏观视觉预警（student 模式下可选返回） */
    paperAppearance?: PaperAppearanceAssessment | null;
    questions: ExamPaperReadQuestion[];
    /** parent_review 模式下的拆题批改结果 */
    reviewQuestions?: ParentReviewQuestion[];
}

/** 去掉 AI 用来表示"没写"的占位值 */
function cleanField(value: string | null): string | null {
    const text = value?.trim();
    return text && !/^(null|none|n\/a|未知|unknown|无|空|-+|\?+)$/i.test(text) ? text.slice(0, 50) : null;
}

function clampConfidence(raw: number | null | undefined): number | null {
    if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
    return Math.max(0, Math.min(1, raw));
}

/** 解析 AI 读卷回复（JSON，可带代码块） */
export function parseExamPaperRead(text: string, pageCount = 1): ExamPaperReadResult {
    const parsed = ExamPaperReadSchema.parse(extractJsonObject(text));
    const safePages = Math.max(1, pageCount);
    return {
        studentName: cleanField(parsed.studentName),
        className: cleanField(parsed.className),
        studentNo: cleanField(parsed.studentNo),
        paperAppearance: parsed.paperAppearance ?? null,
        questions: parsed.questions
            .filter((question) => question.number)
            .map((question) => ({
                ...question,
                confidence: clampConfidence(question.confidence),
                bbox: question.bbox ? validateQuestionBBox(question.bbox, safePages) : null,
            })),
    };
}

/** 拆分 data URL，返回纯 base64 和 MIME 类型 */
export function splitDataUrl(value: string, fallbackMime = 'image/jpeg'): { base64: string; mimeType: string } {
    const match = value.match(/^data:([^;]+);base64,([\s\S]*)$/);
    return match ? { mimeType: match[1], base64: match[2] } : { mimeType: fallbackMime, base64: value };
}


/** 按读卷模式解析模型输出。parent_review 走家长批改结构，并按页数校验 bbox。 */
export function parseExamPaperByMode(mode: ExamPaperReadMode, text: string, pageCount = 1): ExamPaperReadResult {
    if (mode === 'parent_review') {
        const review = parseParentPaperReview(text, pageCount);
        return { studentName: null, className: null, studentNo: null, paperAppearance: null, questions: [], reviewQuestions: review.questions };
    }
    return { ...parseExamPaperRead(text, pageCount), reviewQuestions: [] };
}
