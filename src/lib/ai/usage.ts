/**
 * 把各提供商返回的用量字段统一成 TokenUsage。
 */
import type { TokenUsage } from './types';
import { extractJsonObject } from './schema';

export function usageFromOpenAi(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | null | undefined): TokenUsage | undefined {
    if (!usage) return undefined;
    const result: TokenUsage = {};
    if (typeof usage.prompt_tokens === 'number') result.promptTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === 'number') result.completionTokens = usage.completion_tokens;
    if (typeof usage.total_tokens === 'number') result.totalTokens = usage.total_tokens;
    if (typeof usage.cost === 'number') result.cost = usage.cost;
    return Object.keys(result).length ? result : undefined;
}

export function usageFromAnthropic(usage: { input_tokens?: number; output_tokens?: number } | null | undefined): TokenUsage | undefined {
    if (!usage) return undefined;
    const promptTokens = usage.input_tokens;
    const completionTokens = usage.output_tokens;
    if (typeof promptTokens !== 'number' && typeof completionTokens !== 'number') return undefined;
    return {
        promptTokens,
        completionTokens,
        totalTokens: (promptTokens || 0) + (completionTokens || 0),
    };
}

export function usageFromGemini(usage: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null | undefined): TokenUsage | undefined {
    if (!usage) return undefined;
    const result: TokenUsage = {};
    if (typeof usage.promptTokenCount === 'number') result.promptTokens = usage.promptTokenCount;
    if (typeof usage.candidatesTokenCount === 'number') result.completionTokens = usage.candidatesTokenCount;
    if (typeof usage.totalTokenCount === 'number') result.totalTokens = usage.totalTokenCount;
    return Object.keys(result).length ? result : undefined;
}

export function parseJsonCompletion(text: string, usage?: TokenUsage): { data: unknown; text: string; usage?: TokenUsage } {
    if (!text.trim()) throw new Error('Empty response from AI');
    return { data: extractJsonObject(text), text, usage };
}
