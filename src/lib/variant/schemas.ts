/**
 * 变式流水线各阶段的结构化输出（zod 校验）
 */
import { z } from 'zod';

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'harder'] as const;
export type VariantDifficulty = (typeof DIFFICULTIES)[number];

export const variantDifficultySchema = z.enum(DIFFICULTIES);

export const variantPlanItemSchema = z.object({
    index: z.number().int().min(0).optional(),
    vary: z.string().trim().min(1).max(500),
    skill: z.string().trim().min(1).max(200),
    knowledgePoints: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    difficulty: variantDifficultySchema,
    errorTypeFocus: z.string().trim().max(100).optional(),
    sourceHint: z.string().trim().max(200).optional(),
});
export type VariantPlanItem = z.infer<typeof variantPlanItemSchema>;

export const variantPlanSchema = z.object({
    analysis: z.string().trim().max(2000).default(''),
    variants: z.array(variantPlanItemSchema).min(1).max(8),
});
export type VariantPlan = z.infer<typeof variantPlanSchema>;

export const computableSpecSchema = z.object({
    /** expression 求值；equation 方程两端；numeric 纯数值答案 */
    type: z.enum(['expression', 'equation', 'numeric']),
    /** 只允许数学表达式，禁止代码。equation 用 = 连接两端 */
    expression: z.string().trim().min(1).max(400),
    expected: z.string().trim().min(1).max(200).optional(),
}).nullable().optional();
export type ComputableSpec = z.infer<typeof computableSpecSchema>;

export const variantQuestionSchema = z.object({
    questionText: z.string().trim().min(1).max(8000),
    answerText: z.string().trim().min(1).max(4000),
    analysis: z.string().trim().min(1).max(8000),
    figureSvg: z.string().trim().max(20000).nullable().optional(),
    knowledgePoints: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    computable: computableSpecSchema,
});
export type VariantQuestion = z.infer<typeof variantQuestionSchema>;

export const variantResolveSchema = z.object({
    answer: z.string().trim().min(1).max(4000),
    steps: z.string().trim().max(4000).optional(),
});
export type VariantResolve = z.infer<typeof variantResolveSchema>;

export const variantDifficultyCheckSchema = z.object({
    difficulty: variantDifficultySchema,
    reason: z.string().trim().max(500).default(''),
    consistent: z.boolean(),
});
export type VariantDifficultyCheck = z.infer<typeof variantDifficultyCheckSchema>;

export const topicSuggestionSchema = z.object({
    title: z.string().trim().min(1).max(80),
    knowledgePoints: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
    reason: z.string().trim().min(1).max(1000),
    outline: z.array(z.string().trim().min(1).max(300)).min(2).max(8),
});
export type TopicSuggestion = z.infer<typeof topicSuggestionSchema>;

export const ITEM_STATUSES = ['verified', 'pending_review', 'rejected', 'approved'] as const;
export type VariantItemStatus = (typeof ITEM_STATUSES)[number];

export const RUN_KINDS = ['practice', 'personalized_set', 'topic', 'class_topic', 'legacy'] as const;
export type VariantRunKind = (typeof RUN_KINDS)[number];
