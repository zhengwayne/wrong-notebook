import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_ANTHROPIC_BASE_URL } from '@/lib/ai/anthropic-provider';
import { type AiModelRole } from '@/lib/ai/roles';
import { isVendorProvider, VENDOR_PRESETS } from '@/lib/ai/vendor-presets';
import { getAppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { fetchOutboundSafely, OutboundUrlError, resolveAndAssertSafeOutboundUrl } from '@/lib/outbound-url';
import { resolveTestApiKey, SECRET_MASK } from '@/lib/settings-secrets';
import { defineApiRoute } from '@/lib/server/api-route';

const logger = createLogger('api:ai:models');

interface ModelInfo {
    id: string;
    name: string;
    owned_by?: string;
}

// 从模型 ID 中提取短名称
function extractModelName(modelId: string): string {
    // models/gemini-2.0-flash -> gemini-2.0-flash
    return modelId.replace(/^models\//, '');
}

async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}`;

    const response = await fetchOutboundSafely(url, {
        headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
        const errorText = await response.text();
        logger.error({ status: response.status, errorText }, 'Gemini models API error');
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json() as { models?: { name: string }[] };
    return (data.models || [])
        .map((m) => {
            const id = extractModelName(m.name);
            return {
                id,
                name: id,
                owned_by: 'Google',
            };
        });
}

async function fetchOpenAIModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl}/models`;

    const response = await fetchOutboundSafely(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        logger.error({ statusText: response.statusText }, 'OpenAI models API error');
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json() as { data?: { id: string; owned_by?: string }[] };

    return (data.data || [])
        .map((model) => ({
            id: model.id,
            name: model.id,
            owned_by: model.owned_by,
        }));
}

async function fetchAnthropicModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const response = await fetchOutboundSafely(`${baseUrl}/v1/models?limit=100`, {
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
    });

    if (!response.ok) {
        logger.error({ status: response.status }, 'Anthropic models API error');
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return (data.data || []).map((model: { id: string; display_name?: string }) => ({
        id: model.id,
        name: model.display_name || model.id,
        owned_by: 'Anthropic',
    }));
}

/**
 * POST /api/ai/models
 * 用填写的 API Key 拉取模型列表（仅管理员；服务端会请求调用方给出的地址，必须限制使用者）。
 * 用 POST 传参，避免 API Key 出现在 URL 和访问日志中。
 */
export const POST = defineApiRoute<NextRequest>({ auth: 'admin', unauthenticatedStatus: 403 }, async (req) => {
    try {
        const { provider, apiKey: rawApiKey, baseUrl, role, instanceId } = await req.json() as {
            provider?: string;
            apiKey?: string;
            baseUrl?: string;
            role?: AiModelRole;
            instanceId?: string;
        };

        const apiKey = rawApiKey === SECRET_MASK
            ? resolveTestApiKey({ provider, apiKey: rawApiKey, role, instanceId }, getAppConfig())
            : rawApiKey;

        if (!apiKey) {
            return NextResponse.json(
                { error: 'API key is required' },
                { status: 400 }
            );
        }

        let targetBaseUrl: string;
        try {
            const rawTarget = baseUrl || (
                provider === 'anthropic'
                    ? DEFAULT_ANTHROPIC_BASE_URL
                    : isVendorProvider(provider)
                        ? VENDOR_PRESETS[provider].baseUrl
                        : provider === 'gemini'
                            ? 'https://generativelanguage.googleapis.com'
                            : 'https://api.openai.com/v1'
            );
            targetBaseUrl = await resolveAndAssertSafeOutboundUrl(rawTarget);
        } catch (err) {
            if (err instanceof OutboundUrlError) {
                return NextResponse.json({ error: err.message, models: [] }, { status: 400 });
            }
            throw err;
        }

        let models: ModelInfo[] = [];
        if (provider === 'anthropic') {
            models = await fetchAnthropicModels(apiKey, targetBaseUrl);
        } else if (isVendorProvider(provider)) {
            models = await fetchOpenAIModels(apiKey, targetBaseUrl);
        } else if (provider === 'gemini') {
            models = await fetchGeminiModels(apiKey, targetBaseUrl);
        } else {
            // OpenAI-compatible
            models = await fetchOpenAIModels(apiKey, targetBaseUrl);
        }

        return NextResponse.json({ models });

    } catch (error) {
        logger.error({ error }, 'Error fetching models');
        return NextResponse.json(
            { error: (error instanceof Error && error.message) || 'Internal server error', models: [] },
            { status: 200 } // Return 200 with empty models to allow manual input
        );
    }
});
