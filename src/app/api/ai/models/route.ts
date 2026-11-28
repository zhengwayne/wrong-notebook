import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_ANTHROPIC_BASE_URL } from '@/lib/ai/anthropic-provider';
import { type AiModelRole } from '@/lib/ai/roles';
import { isVendorProvider, VENDOR_PRESETS } from '@/lib/ai/vendor-presets';
import { getAppConfig } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { fetchOutboundSafely, OutboundUrlError, resolveAndAssertSafeOutboundUrl } from '@/lib/outbound-url';
import { resolveStoredProviderConn, SECRET_MASK } from '@/lib/settings-secrets';
import { defineApiRoute } from '@/lib/server/api-route';

const logger = createLogger('api:ai:models');

interface ModelInfo {
    id: string;
    name: string;
    owned_by?: string;
}

function normalizeBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '').toLowerCase();
}

// 从模型 ID 中提取短名称
function extractModelName(modelId: string): string {
    // models/gemini-2.0-flash -> gemini-2.0-flash
    return modelId.replace(/^models\//, '');
}

/** Gemini：Base URL 已带 /v1beta 或 /v1 时直接接 /models，否则补 /v1beta */
function geminiModelsUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    return /\/v1(beta)?$/.test(trimmed) ? `${trimmed}/models?pageSize=1000` : `${trimmed}/v1beta/models?pageSize=1000`;
}

async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    // 密钥放在请求头里，不进 URL（避免出现在代理与访问日志中）
    const response = await fetchOutboundSafely(geminiModelsUrl(baseUrl), {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;

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

    // OpenAI 兼容：{ data: [{ id }] }；部分兼容服务返回 { models: [{ id | name }] }
    const data = await response.json() as { data?: { id: string; owned_by?: string }[]; models?: { id?: string; name?: string; owned_by?: string }[] };
    const list: { id?: string; name?: string; owned_by?: string }[] = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return list
        .map((model) => {
            const id = extractModelName(String(model.id || model.name || ''));
            return { id, name: id, owned_by: model.owned_by };
        })
        .filter((model) => model.id);
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

        // 刷新按钮传掩码：服务端取已保存的密钥，密钥不回到浏览器
        const stored = rawApiKey === SECRET_MASK ? resolveStoredProviderConn({ provider, role, instanceId }, getAppConfig()) : null;
        const apiKey = rawApiKey === SECRET_MASK ? stored?.apiKey : rawApiKey;

        if (!apiKey) {
            return NextResponse.json(
                { error: 'API key is required' },
                { status: 400 }
            );
        }

        let targetBaseUrl: string;
        try {
            const defaultTarget = provider === 'anthropic'
                ? DEFAULT_ANTHROPIC_BASE_URL
                : isVendorProvider(provider)
                    ? VENDOR_PRESETS[provider].baseUrl
                    : provider === 'gemini'
                        ? 'https://generativelanguage.googleapis.com'
                        : 'https://api.openai.com/v1';
            // 用已保存的密钥时只请求已保存的地址（未填则为默认地址），避免把密钥发到临时改过的地址
            const rawTarget = stored ? stored.baseUrl || defaultTarget : baseUrl || defaultTarget;
            if (stored && baseUrl?.trim() && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(rawTarget)) {
                return NextResponse.json({ error: 'BASE_URL_CHANGED', models: [] }, { status: 400 });
            }
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

        const seen = new Set<string>();
        models = models.filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
        return NextResponse.json({ models });

    } catch (error) {
        logger.error({ error }, 'Error fetching models');
        return NextResponse.json(
            { error: (error instanceof Error && error.message) || 'Internal server error', models: [] },
            { status: 200 } // Return 200 with empty models to allow manual input
        );
    }
});
