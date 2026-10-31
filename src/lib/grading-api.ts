/** 改卷 API 共用的输入校验 */
import { z } from "zod";
import { GRADING_QUESTION_TYPES, GRADING_VERDICTS, MAX_GRADING_QUESTIONS } from "@/lib/grading";

/** 单页图片：压缩后的 data URL，限制单张约 8MB */
export const imageDataUrlSchema = z.string().max(8 * 1024 * 1024).regex(/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/);
export const MAX_PAGES_PER_PAPER = 8;
export const MAX_PAPERS_PER_UPLOAD = 60;

export const keyQuestionSchema = z.object({
    number: z.string().trim().min(1).max(20),
    type: z.enum(GRADING_QUESTION_TYPES),
    maxScore: z.number().min(0).max(1000),
    answer: z.string().max(5000).default(''),
    acceptedAnswers: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
    questionText: z.string().max(20000).nullish(),
    knowledgePoints: z.array(z.string().trim().min(1).max(100)).max(5).optional(),
});

export const keyQuestionsSchema = z.array(keyQuestionSchema).max(MAX_GRADING_QUESTIONS);

export const languageSchema = z.enum(['zh', 'en']).catch('zh').default('zh');

export const resultOverrideSchema = z.object({
    id: z.string().min(1),
    verdict: z.enum(GRADING_VERDICTS).optional(),
    score: z.number().min(0).max(1000).optional(),
}).refine((value) => value.verdict !== undefined || value.score !== undefined);

/** 拍照时识别出的卷头身份 */
export const identitySchema = z.object({
    className: z.string().trim().max(100).nullish(),
    studentNo: z.string().trim().max(50).nullish(),
    name: z.string().trim().max(50).nullish(),
});
