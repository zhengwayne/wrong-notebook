/**
 * 多 AI 提供商（Gemini / OpenAI / Azure / Anthropic）一致性矩阵单测
 * 覆盖 OPT-03 Batch B：错误归一化、completeJson 异常处理、Gemini MAX_TOKENS 全方法重试、未闭合 <analysis> 兜底与 LongCat 全带图方法适配
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    geminiGenerateContent: vi.fn(),
    openaiCreate: vi.fn(),
    azureCreate: vi.fn(),
    anthropicCreate: vi.fn(),
}));

vi.mock('@google/genai', () => ({
    GoogleGenAI: class MockGoogleGenAI {
        models = { generateContent: mocks.geminiGenerateContent };
    },
}));

vi.mock('openai', () => ({
    default: class MockOpenAI {
        chat = { completions: { create: mocks.openaiCreate } };
    },
    AzureOpenAI: class MockAzureOpenAI {
        chat = { completions: { create: mocks.azureCreate } };
    },
}));

vi.mock('@anthropic-ai/sdk', () => {
    class APIError extends Error {
        status?: number;
        constructor(status?: number, message = 'API Error') {
            super(message);
            this.status = status;
        }
    }
    class APIConnectionError extends APIError {
        constructor(message = 'Connection error') {
            super(undefined, message);
        }
    }
    class APIConnectionTimeoutError extends APIConnectionError {
        constructor() {
            super('Request timed out');
        }
    }
    class MockAnthropic {
        static APIError = APIError;
        static APIConnectionError = APIConnectionError;
        static APIConnectionTimeoutError = APIConnectionTimeoutError;
        messages = { create: mocks.anthropicCreate };
    }
    return { default: MockAnthropic };
});

vi.mock('@/lib/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), box: vi.fn(), divider: vi.fn() }),
}));

vi.mock('@/lib/config', () => ({
    getAppConfig: () => ({ prompts: {} }),
}));

vi.mock('@/lib/ai/tag-service', () => ({
    getMathTagsFromDB: vi.fn(async () => []),
    getTagsFromDB: vi.fn(async () => []),
    prefetchSubjectTags: vi.fn(async () => ({})),
}));

import { GeminiProvider } from '@/lib/ai/gemini-provider';
import { OpenAIProvider } from '@/lib/ai/openai-provider';
import { AzureOpenAIProvider } from '@/lib/ai/azure-provider';
import { AnthropicProvider } from '@/lib/ai/anthropic-provider';
import type { AIService } from '@/lib/ai/types';

function createProviders(modelOverrides?: { gemini?: string; openai?: string; azure?: string; anthropic?: string }): Array<{ name: string; provider: AIService; mockFn: ReturnType<typeof vi.fn> }> {
    return [
        {
            name: 'gemini',
            provider: new GeminiProvider({ apiKey: 'test-key', model: modelOverrides?.gemini || 'gemini-2.0-flash' }),
            mockFn: mocks.geminiGenerateContent,
        },
        {
            name: 'openai',
            provider: new OpenAIProvider({ apiKey: 'test-key', model: modelOverrides?.openai || 'gpt-4o' }),
            mockFn: mocks.openaiCreate,
        },
        {
            name: 'azure',
            provider: new AzureOpenAIProvider({ apiKey: 'test-key', endpoint: 'https://test.openai.azure.com', deploymentName: 'dep-gpt4o', model: modelOverrides?.azure || 'gpt-4o' }),
            mockFn: mocks.azureCreate,
        },
        {
            name: 'anthropic',
            provider: new AnthropicProvider({ apiKey: 'test-key', model: modelOverrides?.anthropic || 'claude-sonnet-5-5' }),
            mockFn: mocks.anthropicCreate,
        },
    ];
}

describe('多 AI 提供商错误归一化与 completeJson 一致性矩阵', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ['401 Unauthorized', Object.assign(new Error('Unauthorized'), { status: 401 }), 'AI_AUTH_ERROR'],
        ['429 Rate limit', Object.assign(new Error('Too many requests'), { status: 429 }), 'AI_QUOTA_EXCEEDED'],
        ['Timeout', new Error('Request timed out'), 'AI_TIMEOUT_ERROR'],
    ])('四提供商 completeJson 与业务方法在 %s 下均抛出统一错误码', async (_label, err, expectedCode) => {
        for (const { provider, mockFn } of createProviders()) {
            mockFn.mockRejectedValueOnce(err);
            await expect(provider.completeJson({ system: 'sys', user: 'usr' })).rejects.toThrow(expectedCode);

            mockFn.mockRejectedValueOnce(err);
            await expect(provider.gradeAnswer({ questionText: '1+1=?', answerText: '2', userAnswer: '2' })).rejects.toThrow(expectedCode);
        }
    });

    it('四提供商均支持未闭合 <analysis> 标签截断兜底', async () => {
        const unclosed = '<question_text>求 3+5 的值。</question_text><answer_text>8</answer_text><analysis>第一步直接相加得到 8，未闭合';
        mocks.geminiGenerateContent.mockResolvedValueOnce({ text: unclosed });
        mocks.openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: unclosed } }] });
        mocks.azureCreate.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: unclosed } }] });
        mocks.anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: unclosed }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });

        for (const { provider } of createProviders()) {
            const q = await provider.generateSimilarQuestion('1+1=?', ['加法']);
            expect(q.analysis).toBe('第一步直接相加得到 8，未闭合');
        }
    });

    it('Azure completeJson 使用 this.model 查询已知上限而非 deployment 名称', async () => {
        const provider = new AzureOpenAIProvider({
            apiKey: 'test-key',
            endpoint: 'https://test.openai.azure.com',
            deploymentName: 'my-opaque-deployment',
            model: 'gpt-4o', // 已知上限 16384
        });
        mocks.azureCreate
            .mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '' } }] })
            .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });

        const res = await provider.completeJson({ system: 's', user: 'u' });
        expect(res.data).toEqual({ ok: true });
        expect(mocks.azureCreate.mock.calls.map((c) => c[0].max_tokens)).toEqual([4096, 16384]);
    });

    it('Anthropic generateFigureSvg 不附带多余固定中文文本块', async () => {
        mocks.anthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: '<has_figure>false</has_figure><figure_svg></figure_svg>' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        });
        const provider = new AnthropicProvider({ apiKey: 'test-key' });
        await provider.generateFigureSvg('QUJD', 'image/png', '如图');
        const content = mocks.anthropicCreate.mock.calls[0][0].messages[0].content;
        expect(content).toHaveLength(2);
    });
});

describe('Gemini 全方法 MAX_TOKENS 截断扩充重试', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('completeJson、generateSimilarQuestion、reanswerQuestion、gradeAnswer、recognizeGrade、readExamPaper 均自动扩充 maxOutputTokens 重试并成功', async () => {
        const provider = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-2.5-pro' });
        const truncated = { text: '', candidates: [{ finishReason: 'MAX_TOKENS' }] };

        // 1. completeJson (4096 -> 65536)
        mocks.geminiGenerateContent
            .mockResolvedValueOnce(truncated)
            .mockResolvedValueOnce({ text: '{"ok":true}' });
        expect((await provider.completeJson({ system: 's', user: 'u' })).data).toEqual({ ok: true });
        expect(mocks.geminiGenerateContent.mock.calls.slice(-2).map((c) => c[0].config.maxOutputTokens)).toEqual([4096, 65536]);

        // 2. generateSimilarQuestion (32768 -> 65536)
        mocks.geminiGenerateContent
            .mockResolvedValueOnce(truncated)
            .mockResolvedValueOnce({ text: '<question_text>求 4+5</question_text><answer_text>9</answer_text><analysis>相加</analysis>' });
        expect((await provider.generateSimilarQuestion('1+1', ['加法'])).answerText).toBe('9');
        expect(mocks.geminiGenerateContent.mock.calls.slice(-2).map((c) => c[0].config.maxOutputTokens)).toEqual([32768, 65536]);

        // 3. reanswerQuestion (32768 -> 65536)
        mocks.geminiGenerateContent
            .mockResolvedValueOnce(truncated)
            .mockResolvedValueOnce({ text: '<answer_text>9</answer_text><analysis>相加</analysis><knowledge_points>加法</knowledge_points>' });
        expect((await provider.reanswerQuestion('4+5=?')).answerText).toBe('9');
        expect(mocks.geminiGenerateContent.mock.calls.slice(-2).map((c) => c[0].config.maxOutputTokens)).toEqual([32768, 65536]);

        // 4. gradeAnswer (4096 -> 65536)
        mocks.geminiGenerateContent
            .mockResolvedValueOnce(truncated)
            .mockResolvedValueOnce({ text: '{"correct":true,"reason":"正确"}' });
        expect((await provider.gradeAnswer({ questionText: '4+5=?', answerText: '9', userAnswer: '9' })).correct).toBe(true);

        // 5. recognizeGrade (1024 -> 65536)
        mocks.geminiGenerateContent
            .mockResolvedValueOnce(truncated)
            .mockResolvedValueOnce({ text: '{"gradeSemester":"四年级上"}' });
        expect(await provider.recognizeGrade('长方形面积')).toBe('四年级上');

        // 6. readExamPaper (32768 -> 65536)
        mocks.geminiGenerateContent
            .mockResolvedValueOnce(truncated)
            .mockResolvedValueOnce({ text: '{"className":null,"studentNo":null,"studentName":null,"questions":[]}' });
        expect((await provider.readExamPaper({ mode: 'identify', images: [{ base64: 'QUJD', mimeType: 'image/png' }] })).questions).toEqual([]);
    });

    it('Gemini 重试后仍因 MAX_TOKENS 为空时抛出 AI_OUTPUT_TRUNCATED', async () => {
        const provider = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-2.5-pro' });
        mocks.geminiGenerateContent.mockResolvedValue({ text: '', candidates: [{ finishReason: 'MAX_TOKENS' }] });
        await expect(provider.completeJson({ system: 's', user: 'u' })).rejects.toThrow('AI_OUTPUT_TRUNCATED');
    });
});

describe('LongCat 多模态 input_image 适配覆盖全带图方法', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('analyzeImage、reanswerQuestion（带图）、readExamPaper、generateFigureSvg 均使用 input_image 且带 AbortSignal 超时', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                choices: [{ finish_reason: 'stop', message: { content: '<question_text>Q</question_text><answer_text>A</answer_text><analysis>An</analysis><has_figure>false</has_figure><figure_svg></figure_svg>{"className":null,"studentNo":null,"studentName":null,"questions":[]}' } }],
            }),
        }));
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        const provider = new OpenAIProvider({ apiKey: 'lc-key', baseUrl: 'https://api.longcat.chat/openai/v1', model: 'LongCat-Flash-Chat' });

        await provider.analyzeImage('QUJD', 'image/png');
        await provider.reanswerQuestion('Q', 'zh', '数学', 'data:image/jpeg;base64,QUJD');
        await provider.generateFigureSvg('QUJD', 'image/png', 'Q');
        await provider.readExamPaper({ mode: 'identify', images: [{ base64: 'QUJD', mimeType: 'image/png' }] });

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit & { signal?: AbortSignal }]>) {
            const init = call[1];
            expect(init.signal).toBeDefined();
            const body = JSON.parse(String(init.body)) as { messages: Array<{ role?: string; content: unknown }> };
            const userMsg = body.messages.find((m) => m.role === 'user');
            expect(userMsg).toBeDefined();
            const parts = userMsg!.content as Array<{ type: string; input_image?: { data: string[]; type: string } }>;
            expect(parts.some((p) => p.type === 'input_image' && Array.isArray(p.input_image?.data))).toBe(true);
            expect(parts.some((p) => p.type === 'image_url')).toBe(false);
        }
    });
});
