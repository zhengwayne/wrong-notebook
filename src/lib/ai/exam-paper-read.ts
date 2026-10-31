import { z } from "zod";
import { extractJsonObject } from "./schema";

/** 读卷输入：答案卷识别或学生答卷识别，多页图片按顺序传入 */
export interface ExamPaperReadInput {
    mode: 'answer_key' | 'student';
    /** data URL 或纯 base64 */
    images: { base64: string; mimeType: string }[];
    /** 学生答卷模式下的题目清单（题号、题型、分值、标准答案） */
    questions?: { number: string; type: 'objective' | 'subjective'; maxScore: number; answer: string; questionText?: string | null }[];
    language?: 'zh' | 'en';
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
    reason: z.string().nullish().catch(null),
    questionText: z.string().nullish().catch(null),
    knowledgePoints: z.array(z.string()).catch([]).optional(),
});

const ExamPaperReadSchema = z.object({
    studentName: z.string().nullish().catch(null),
    questions: z.array(ReadQuestionSchema).max(200),
});

export type ExamPaperReadQuestion = z.infer<typeof ReadQuestionSchema>;
export interface ExamPaperReadResult {
    studentName: string | null;
    questions: ExamPaperReadQuestion[];
}

/** 解析 AI 读卷回复（JSON，可带代码块） */
export function parseExamPaperRead(text: string): ExamPaperReadResult {
    const parsed = ExamPaperReadSchema.parse(extractJsonObject(text));
    const name = parsed.studentName?.trim();
    return {
        studentName: name && !/^(null|未知|unknown|无)$/i.test(name) ? name : null,
        questions: parsed.questions.filter((question) => question.number),
    };
}

/** 拆分 data URL，返回纯 base64 和 MIME 类型 */
export function splitDataUrl(value: string, fallbackMime = 'image/jpeg'): { base64: string; mimeType: string } {
    const match = value.match(/^data:([^;]+);base64,([\s\S]*)$/);
    return match ? { mimeType: match[1], base64: match[2] } : { mimeType: fallbackMime, base64: value };
}
