/**
 * 把现有 AI 提供商的 completeJson 接到变式流水线所需的规划、生成、重解、难度与专题接口。
 */
import { getAIService } from '@/lib/ai';
import type { TokenUsage as AiUsage } from '@/lib/ai/types';
import {
    generateTopicSuggestionRequest, generateVariantDifficultyRequest,
    generateVariantPlanRequest, generateVariantQuestionRequest, generateVariantResolveRequest,
} from '@/lib/ai/prompt-requests';
import type { TokenUsage, VariantAi } from './pipeline';
import type { TopicSuggestion } from './schemas';
import { topicSuggestionSchema } from './schemas';

function toUsage(usage?: AiUsage): TokenUsage | undefined {
    return usage;
}

export function createVariantAi(): VariantAi {
    const service = getAIService();
    return {
        async plan(input) {
            const result = await service.completeJson(generateVariantPlanRequest({
                originalQuestion: input.question,
                knowledgePoints: input.knowledgePoints,
                errorType: input.errorType || null,
                difficulty: input.difficulty,
                count: input.count,
                slots: input.slots || [],
            }, input.language));
            return { data: result.data, usage: toUsage(result.usage) };
        },
        async generate(input) {
            const result = await service.completeJson(generateVariantQuestionRequest({
                originalQuestion: input.question,
                plan: input.plan,
                previousStems: input.previousStems,
            }, input.language));
            return { data: result.data, usage: toUsage(result.usage) };
        },
        async resolve(input) {
            const result = await service.completeJson(generateVariantResolveRequest({
                questionText: input.questionText,
            }, input.language));
            return { data: result.data, usage: toUsage(result.usage) };
        },
        async checkDifficulty(input) {
            const result = await service.completeJson(generateVariantDifficultyRequest({
                questionText: input.questionText,
                target: input.target,
            }, input.language));
            return { data: result.data, usage: toUsage(result.usage) };
        },
    };
}

export async function suggestTopic(input: { knowledgePoints: string[]; reason: string; language: 'zh' | 'en'; studentCount?: number }): Promise<{ data: TopicSuggestion; usage?: TokenUsage }> {
    const result = await getAIService().completeJson(generateTopicSuggestionRequest({
        knowledgePoints: input.knowledgePoints,
        reason: input.reason,
        studentCount: input.studentCount ?? 1,
    }, input.language));
    const parsed = topicSuggestionSchema.safeParse(result.data);
    if (!parsed.success) throw new Error('TOPIC_INVALID');
    return { data: parsed.data, usage: toUsage(result.usage) };
}
