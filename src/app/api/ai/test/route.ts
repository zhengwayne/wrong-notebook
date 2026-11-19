import { NextRequest, NextResponse } from 'next/server';
import { OpenAIProvider, DEFAULT_OPENAI_MODEL } from '@/lib/ai/openai-provider';
import { GeminiProvider } from '@/lib/ai/gemini-provider';
import { AzureOpenAIProvider } from '@/lib/ai/azure-provider';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from '@/lib/ai/anthropic-provider';
import { MiniMaxCodeProvider } from '@/lib/ai/minimax-code-provider';
import { DEFAULT_MINIMAX_CODE_MODEL } from '@/lib/minimax-code/constants';
import { withAiCallDeadline } from '@/lib/ai/deadline';
import { classifyAiErrorText } from '@/lib/ai/error-text-classification';
import { isVendorProvider, resolveVendorConfig } from '@/lib/ai/vendor-presets';
import type { VendorProviderId } from '@/lib/ai/vendor-presets';
import type { AiModelRole } from '@/lib/ai/roles';
import type { AIService } from '@/lib/ai/types';
import { getAppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { getErrorDetail } from '@/lib/error-message';
import { OutboundUrlError, resolveAndAssertSafeOutboundUrl } from '@/lib/outbound-url';
import { resolveTestApiKey, SECRET_MASK } from '@/lib/settings-secrets';
import { defineApiRoute } from '@/lib/server/api-route';

const logger = createLogger('api:ai:test');

// 测试用图片：简单的数学题 "2 + 3 = ?"（约 1.7KB）
const TEST_IMAGE_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABkAMgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD2aiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACobu5js7SW5lDFIkLsEXJIA6AdzU1QXpuxZTfYVha62HyhOxCbu24gE4+lAEOm6kmorPiCa3ltpfKmhm27kbarfwkg5VlPBPWrAuYXgeaOQSohYMY/n5UkMOO4IIx1yMVQ0XT57XS3tr1EWaRmaWSK4Z2lZurltqkEnPAHAAx04ZpegnR9MurW0vJjNPJNIksrvIIy7u6/KzHpu5P8WMnk0ATabrEeozz25tbi1ngRJGinC7tr52n5WOM7W4OCMcjpVy5uEtbWW5k3bIULttUscAZOAOprL0fS7m2vL+7uobS2a9Cb4bUlkLjdukJKj5m3AHjog5NS6NoNtonnfZ33edt3fuIY+mf+eaLnr3z7d6AJ9N1NNSSbEE1vLby+VLDMF3I21WH3SR91lPB71dqpYWYtEmyoDzTySud27dluOcD+EKMdsYycZNugAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';
const TEST_IMAGE_MIME = 'image/jpeg';

// 解析错误并返回标准化错误代码（前端负责翻译）；与 error-normalizer / background-tasks 共享归类规则
function parseErrorCode(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);

    // 1. 首先检查是否是 AI Provider 抛出的标准错误代码（直接传递）
    const aiErrorCodes = [
        'AI_CONNECTION_FAILED', 'AI_TIMEOUT_ERROR', 'AI_QUOTA_EXCEEDED',
        'AI_PERMISSION_DENIED', 'AI_NOT_FOUND', 'AI_RESPONSE_ERROR',
        'AI_AUTH_ERROR', 'AI_SERVICE_UNAVAILABLE', 'AI_UNKNOWN_ERROR'
    ];
    for (const code of aiErrorCodes) {
        if (msg.includes(code)) {
            return code;
        }
    }

    // 2. 原始错误消息复用统一分类器
    return classifyAiErrorText(msg) ?? 'AI_UNKNOWN_ERROR';
}

function buildTestProvider(params: {
    provider: AITestRequest['provider'];
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    endpoint?: string;
    deploymentName?: string;
    apiVersion?: string;
}): { service: AIService; modelName: string } | null {
    const { provider, apiKey, baseUrl, model, endpoint, deploymentName, apiVersion } = params;
    if (provider === 'openai') {
        return { service: withAiCallDeadline(new OpenAIProvider({ apiKey, baseUrl, model })), modelName: model || DEFAULT_OPENAI_MODEL };
    }
    if (provider === 'gemini') {
        return { service: withAiCallDeadline(new GeminiProvider({ apiKey, baseUrl, model })), modelName: model || 'gemini-2.0-flash' };
    }
    if (provider === 'anthropic') {
        return { service: withAiCallDeadline(new AnthropicProvider({ apiKey, baseUrl, model })), modelName: model || DEFAULT_ANTHROPIC_MODEL };
    }
    if (provider === 'minimax-code') {
        return { service: withAiCallDeadline(new MiniMaxCodeProvider({ model })), modelName: model || DEFAULT_MINIMAX_CODE_MODEL };
    }
    if (isVendorProvider(provider)) {
        const vendorConfig = resolveVendorConfig(provider, { apiKey, baseUrl, model });
        return { service: withAiCallDeadline(new OpenAIProvider(vendorConfig)), modelName: vendorConfig.model };
    }
    if (provider === 'azure') {
        return {
            service: withAiCallDeadline(new AzureOpenAIProvider({ apiKey, endpoint, deploymentName, apiVersion, model })),
            modelName: model || deploymentName || '',
        };
    }
    return null;
}

export interface AITestRequest {
    provider: 'openai' | 'gemini' | 'azure' | 'anthropic' | 'minimax-code' | VendorProviderId;
    /** MiniMax Code 使用已登录的凭据，不需要 apiKey */
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    role?: AiModelRole;
    instanceId?: string;
    // Azure 特有
    endpoint?: string;
    deploymentName?: string;
    apiVersion?: string;
    // 语言
    language?: 'zh' | 'en';
}

export interface AITestResponse {
    success: boolean;
    textSupport: boolean;
    visionSupport: boolean;
    textError?: string;
    visionError?: string;
    /** 服务商的原始报错，便于管理员排查 */
    textErrorDetail?: string;
    visionErrorDetail?: string;
    modelInfo?: string;
}

export const POST = defineApiRoute<NextRequest>({ auth: 'admin' }, async (request) => {
    try {

        const body: AITestRequest = await request.json();
        const { provider, apiKey: rawApiKey, baseUrl, model, role, instanceId, endpoint, deploymentName, apiVersion, language = 'zh' } = body;

        const apiKey = rawApiKey === SECRET_MASK
            ? resolveTestApiKey({ provider, apiKey: rawApiKey, role, instanceId }, getAppConfig())
            : rawApiKey;

        if (!provider || (!apiKey && provider !== 'minimax-code')) {
            return NextResponse.json({ error: 'Missing provider or apiKey' }, { status: 400 });
        }

        const rawTargetUrl = provider === 'azure' ? endpoint : baseUrl;
        if (typeof rawTargetUrl === 'string' && rawTargetUrl.trim()) {
            try {
                await resolveAndAssertSafeOutboundUrl(rawTargetUrl.trim());
            } catch (err) {
                if (err instanceof OutboundUrlError) {
                    return NextResponse.json({ error: err.message }, { status: 400 });
                }
                throw err;
            }
        }

        logger.info({ provider, model, baseUrl: baseUrl || endpoint }, 'AI 连接测试开始');

        let textSupport = false;
        let visionSupport = false;
        let textError: string | undefined;
        let visionError: string | undefined;
        let textErrorDetail: string | undefined;
        let visionErrorDetail: string | undefined;
        let modelInfo: string | undefined;

        // 辅助函数：判断错误是否为配置/连接问题（不应继续文本测试）
        const isConfigError = (errorCode: string) => {
            return ['AI_AUTH_ERROR', 'AI_CONNECTION_FAILED', 'AI_TIMEOUT_ERROR',
                'AI_QUOTA_EXCEEDED', 'AI_PERMISSION_DENIED', 'AI_SERVICE_UNAVAILABLE'].includes(errorCode);
        };

        if (provider === 'azure' && (!endpoint || !deploymentName)) {
            return NextResponse.json({ error: 'Azure 需要 endpoint 和 deploymentName' }, { status: 400 });
        }

        // 优化策略：先视觉测试，成功则一步完成；失败则根据错误类型决定是否进行文本测试
        // 测试 1: 视觉（多模态）能力
        try {
            const built = buildTestProvider({ provider, apiKey, baseUrl, model, endpoint, deploymentName, apiVersion });
            if (built) {
                const result = await built.service.analyzeImage(TEST_IMAGE_BASE64, TEST_IMAGE_MIME, language);
                if (result.questionText || result.analysis) {
                    // 视觉成功 → 文本和视觉都支持，一步完成
                    textSupport = true;
                    visionSupport = true;
                    modelInfo = built.modelName;
                }
            }
        } catch (error) {
            const errCode = parseErrorCode(error);
            const errMsg = error instanceof Error ? error.message : String(error);
            visionErrorDetail = getErrorDetail(error);

            logger.info({ error: errMsg, errorCode: errCode, provider }, '视觉测试失败');

            // 如果是配置/连接问题，直接返回错误，不再测试文本
            if (isConfigError(errCode)) {
                textError = errCode;
                visionError = errCode;
                textErrorDetail = visionErrorDetail;
                logger.warn({ errorCode: errCode, provider }, '配置错误，跳过文本测试');
            } else {
                // 非配置错误（如模型不支持多模态），标记为视觉不支持
                visionError = 'VISION_NOT_SUPPORTED';
            }
        }

        // 测试 2: 文本生成能力（仅在视觉失败且非配置错误时进行）
        if (!textSupport && !textError) {
            try {
                const built = buildTestProvider({ provider, apiKey, baseUrl, model, endpoint, deploymentName, apiVersion });
                if (built) {
                    const result = await built.service.generateSimilarQuestion('1+1=?', ['基础算术'], language, 'easy');
                    if (result.questionText) {
                        textSupport = true;
                        modelInfo = built.modelName;
                    }
                }
            } catch (error) {
                textError = parseErrorCode(error);
                textErrorDetail = getErrorDetail(error);
                logger.warn({ error, provider }, '文本生成测试失败');
            }
        }

        const response: AITestResponse = {
            success: textSupport,
            textSupport,
            visionSupport,
            textError,
            visionError,
            textErrorDetail,
            visionErrorDetail,
            modelInfo
        };

        logger.info({ response }, 'AI 连接测试完成');

        return NextResponse.json(response);

    } catch (error) {
        logger.error({ error }, 'AI 测试 API 异常');
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Internal server error' },
            { status: 500 }
        );
    }
});
