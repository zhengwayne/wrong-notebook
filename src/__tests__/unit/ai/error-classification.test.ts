/**
 * AI 错误归类：网络中断、服务商 401 原文、空正文等不再落到未知错误
 * （Ported from margrop/wrong-notebook f89d8a0a、49121588, MIT）
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { normalizeAiError } from '@/lib/ai/error-normalizer';
import { classifyAiErrorText } from '@/lib/ai/error-text-classification';

function normalized(error: unknown): string {
    try {
        normalizeAiError(error, 'Test');
    } catch (thrown) {
        return (thrown as Error).message;
    }
    throw new Error('normalizeAiError must throw');
}

describe('classifyAiErrorText', () => {
    it.each([
        ['terminated', 'AI_CONNECTION_FAILED'],
        ['socket hang up', 'AI_CONNECTION_FAILED'],
        ['other side closed', 'AI_CONNECTION_FAILED'],
        ['write EPIPE', 'AI_CONNECTION_FAILED'],
        ['Invalid AI response: missing <answer>', 'AI_RESPONSE_ERROR'],
        ['Empty response from model', 'AI_RESPONSE_ERROR'],
        ['401 Authentication Fails, Your api key: ****T6qA is invalid (request_id: cb727c1a)', 'AI_AUTH_ERROR'],
        // request_id 里出现 502 也不能盖过开头的 401
        ['401 Authentication Fails (request_id: 5021aa)', 'AI_AUTH_ERROR'],
        ['429 Too Many Requests', 'AI_QUOTA_EXCEEDED'],
        ['503 Service Unavailable', 'AI_SERVICE_UNAVAILABLE'],
    ])('%s → %s', (message, code) => {
        expect(classifyAiErrorText(message)).toBe(code);
    });

    it('无法判断时返回 null', () => {
        expect(classifyAiErrorText('something odd')).toBeNull();
        expect(classifyAiErrorText('')).toBeNull();
    });
});

describe('normalizeAiError', () => {
    it('undici 连接中断的 TypeError 归为连接失败', () => {
        expect(normalized(new TypeError('terminated'))).toBe('AI_CONNECTION_FAILED');
    });

    it('服务商 401 原文归为认证错误', () => {
        expect(normalized(new Error('401 Authentication Fails, Your api key: ****T6qA is invalid'))).toBe('AI_AUTH_ERROR');
    });

    it('带状态码的 SDK 错误按状态码归类', () => {
        expect(normalized(Object.assign(new Error('boom'), { status: 401 }))).toBe('AI_AUTH_ERROR');
        expect(normalized(Object.assign(new Error('boom'), { status: 502 }))).toBe('AI_SERVICE_UNAVAILABLE');
    });

    it('已归类的错误码原样透传，未知错误仍为 AI_UNKNOWN_ERROR', () => {
        expect(normalized(new Error('AI_TIMEOUT_ERROR'))).toBe('AI_TIMEOUT_ERROR');
        expect(normalized(new Error('weird'))).toBe('AI_UNKNOWN_ERROR');
    });
});
