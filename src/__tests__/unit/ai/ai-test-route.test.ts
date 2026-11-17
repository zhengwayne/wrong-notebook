/**
 * /api/ai/test 权限测试：测试会让服务端请求调用方给出的地址，只允许管理员
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    userFindUnique: vi.fn(),
    getAppConfig: vi.fn(),
    analyzeImage: vi.fn(),
    generateSimilarQuestion: vi.fn(),
    openaiAnalyzeImage: vi.fn(),
    openaiGenerateSimilar: vi.fn(),
    geminiAnalyzeImage: vi.fn(),
    geminiGenerateSimilar: vi.fn(),
    azureAnalyzeImage: vi.fn(),
    azureGenerateSimilar: vi.fn(),
    openaiConfigs: [] as Array<Record<string, unknown>>,
    geminiConfigs: [] as Array<Record<string, unknown>>,
    withAccessToken: vi.fn(),
}));

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: mocks.userFindUnique } } }));
vi.mock('@/lib/config', () => ({ getAppConfig: mocks.getAppConfig }));
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), box: vi.fn(), divider: vi.fn() })),
}));
vi.mock('@/lib/minimax-code/auth', () => ({ withAccessToken: mocks.withAccessToken }));
vi.mock('@/lib/ai/openai-provider', () => ({
    DEFAULT_OPENAI_MODEL: 'gpt-4o',
    OpenAIProvider: class {
        constructor(config: Record<string, unknown>) {
            mocks.openaiConfigs.push(config);
        }
        analyzeImage = mocks.openaiAnalyzeImage;
        generateSimilarQuestion = mocks.openaiGenerateSimilar;
    },
}));
vi.mock('@/lib/ai/gemini-provider', () => ({
    GeminiProvider: class {
        constructor(config: Record<string, unknown>) {
            mocks.geminiConfigs.push(config);
        }
        analyzeImage = mocks.geminiAnalyzeImage;
        generateSimilarQuestion = mocks.geminiGenerateSimilar;
    },
}));
vi.mock('@/lib/ai/azure-provider', () => ({
    AzureOpenAIProvider: class {
        analyzeImage = mocks.azureAnalyzeImage;
        generateSimilarQuestion = mocks.azureGenerateSimilar;
    },
}));
vi.mock('@/lib/ai/anthropic-provider', () => ({
    DEFAULT_ANTHROPIC_MODEL: 'claude-sonnet-5-5',
    AnthropicProvider: class {
        analyzeImage = mocks.analyzeImage;
        generateSimilarQuestion = mocks.generateSimilarQuestion;
    },
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ai/test/route';

function makeRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost/api/ai/test', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('POST /api/ai/test', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.openaiConfigs.length = 0;
        mocks.geminiConfigs.length = 0;
        mocks.getAppConfig.mockReturnValue({ aiProvider: 'gemini' });
        mocks.userFindUnique.mockImplementation(async ({ where }: { where?: { id?: string } }) => {
            if (where?.id === 'a1') return { id: 'a1', email: 'admin@localhost', role: 'admin', isActive: true, authVersion: 0 };
            if (where?.id === 'u1') return { id: 'u1', email: 'user@localhost', role: 'user', isActive: true, authVersion: 0 };
            return null;
        });
    });

    it('普通用户返回 403，且不调用 AI', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'u1', role: 'user' }, expires: '2099-01-01' });

        const response = await POST(makeRequest({ provider: 'anthropic', apiKey: 'k', baseUrl: 'http://10.0.0.1' }));

        expect(response.status).toBe(403);
        expect(mocks.analyzeImage).not.toHaveBeenCalled();
    });

    it('管理员可以测试 Anthropic 提供商', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'a1', role: 'admin' }, expires: '2099-01-01' });
        mocks.analyzeImage.mockResolvedValue({ questionText: '2 + 3 = ?', analysis: '加法' });

        const response = await POST(makeRequest({ provider: 'anthropic', apiKey: 'k' }));
        const data = await response.json();

        expect(data).toMatchObject({ success: true, visionSupport: true, modelInfo: 'claude-sonnet-5-5' });
    });

    it('MiniMax Code 不需要 apiKey，使用已登录的凭据', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'a1', role: 'admin' }, expires: '2099-01-01' });
        mocks.withAccessToken.mockImplementation((fn: (token: string) => Promise<unknown>) => fn('mmoat_x'));
        mocks.analyzeImage.mockResolvedValue({ questionText: '2 + 3 = ?', analysis: '加法' });

        const response = await POST(makeRequest({ provider: 'minimax-code' }));
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data).toMatchObject({ success: true, visionSupport: true, modelInfo: 'MiniMax-M3.1-Flash' });
    });

    it('MiniMax Code 未登录时返回 AI_AUTH_ERROR', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'a1', role: 'admin' }, expires: '2099-01-01' });
        mocks.withAccessToken.mockRejectedValue(new Error('AI_AUTH_ERROR: MiniMax Code is not logged in'));

        const data = await (await POST(makeRequest({ provider: 'minimax-code' }))).json();

        expect(data).toMatchObject({ success: false, visionError: 'AI_AUTH_ERROR', textError: 'AI_AUTH_ERROR' });
        expect(mocks.analyzeImage).not.toHaveBeenCalled();
    });

    it('传入掩码密钥 ******** 时按 role 与 instanceId 还原（含关闭 textSameAsVision 回退 vision）', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'a1', role: 'admin' }, expires: '2099-01-01' });
        mocks.getAppConfig.mockReturnValue({
            aiProvider: 'gemini',
            gemini: { apiKey: 'AIza-vision-secret', model: 'gemini-2.5-flash' },
            openai: {
                instances: [
                    { id: 'inst-1', name: 'One', apiKey: 'sk-first', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
                    { id: 'inst-2', name: 'Two', apiKey: 'sk-second', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                ],
                activeInstanceId: 'inst-1',
            },
        });
        mocks.geminiAnalyzeImage.mockResolvedValue({ questionText: '2 + 3 = ?', analysis: '加法' });
        mocks.openaiAnalyzeImage.mockResolvedValue({ questionText: '2 + 3 = ?', analysis: '加法' });

        const textRes = await POST(makeRequest({ provider: 'gemini', apiKey: '********', role: 'text' }));
        expect(textRes.status).toBe(200);
        expect(mocks.geminiConfigs[0]?.apiKey).toBe('AIza-vision-secret');

        const oaiRes = await POST(makeRequest({ provider: 'openai', apiKey: '********', role: 'vision', instanceId: 'inst-2' }));
        expect(oaiRes.status).toBe(200);
        expect(mocks.openaiConfigs[0]?.apiKey).toBe('sk-second');
    });

    it('管理员传入云元数据或全零地址时返回 400 且不调用 AI；本地局域网地址放行', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'a1', role: 'admin' }, expires: '2099-01-01' });
        for (const badUrl of ['http://169.254.169.254/latest', 'http://0.0.0.0:11434/v1', 'file:///etc/passwd']) {
            const res = await POST(makeRequest({ provider: 'openai', apiKey: 'sk-k', baseUrl: badUrl }));
            expect(res.status).toBe(400);
        }
        expect(mocks.openaiAnalyzeImage).not.toHaveBeenCalled();

        mocks.openaiAnalyzeImage.mockResolvedValue({ questionText: '2 + 3 = ?', analysis: '加法' });
        const lanRes = await POST(makeRequest({ provider: 'openai', apiKey: 'ollama', baseUrl: 'http://192.168.1.88:11434/v1' }));
        expect(lanRes.status).toBe(200);
        expect(mocks.openaiAnalyzeImage).toHaveBeenCalledTimes(1);
    });

    it('覆盖缺参 400、Azure/国产渠道、视觉不支持回退文本生成与标准错误码映射', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'a1', role: 'admin' }, expires: '2099-01-01' });

        expect((await POST(makeRequest({ provider: 'openai' }))).status).toBe(400);
        expect((await POST(makeRequest({ provider: 'azure', apiKey: 'az-key' }))).status).toBe(400);

        mocks.azureAnalyzeImage.mockResolvedValueOnce({ questionText: '2+3=?', analysis: 'ok' });
        const azOk = await POST(makeRequest({
            provider: 'azure',
            apiKey: 'az-key',
            endpoint: 'https://example.openai.azure.com',
            deploymentName: 'gpt-4o-deploy',
        }));
        expect(await azOk.json()).toMatchObject({ success: true, visionSupport: true, modelInfo: 'gpt-4o-deploy' });

        // 国产渠道预设：视觉报错非配置错误时回退测试 generateSimilarQuestion
        mocks.openaiAnalyzeImage.mockRejectedValueOnce(new Error('invalid json from vision'));
        mocks.openaiGenerateSimilar.mockResolvedValueOnce({ questionText: '1+2=?' });
        const dsRes = await (await POST(makeRequest({ provider: 'deepseek', apiKey: 'ds-key' }))).json();
        expect(dsRes).toMatchObject({
            success: true,
            textSupport: true,
            visionSupport: false,
            visionError: 'VISION_NOT_SUPPORTED',
        });

        // 视觉失败且文本同样遭遇 429 限流
        mocks.geminiAnalyzeImage.mockRejectedValueOnce(new Error('invalid json'));
        mocks.geminiGenerateSimilar.mockRejectedValueOnce(new Error('429 rate limit exceeded'));
        const bothFail = await (await POST(makeRequest({ provider: 'gemini', apiKey: 'g-key' }))).json();
        expect(bothFail).toMatchObject({
            success: false,
            textSupport: false,
            visionSupport: false,
            visionError: 'VISION_NOT_SUPPORTED',
            textError: 'AI_QUOTA_EXCEEDED',
        });
    });
});
