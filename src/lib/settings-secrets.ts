import type { AiModelRole } from '@/lib/ai/roles';
import { isVendorProvider, VENDOR_PROVIDER_IDS, type VendorProviderId } from '@/lib/ai/vendor-presets';
import { CLOUD_TTS_PROVIDERS, type TtsConfig } from '@/lib/tts/constants';
import type { AppConfig, OpenAIInstance, TextAiConfig } from '@/types/api';

export const SECRET_MASK = '********';

type SecretHolder = { apiKey?: string } | undefined;

/** 仅对非空字符串脱敏；空串或未设置保持原样，避免向导误判为已配置 */
export function maskSecretValue(apiKey: string | undefined): string | undefined {
    if (typeof apiKey === 'string' && apiKey.length > 0) {
        return SECRET_MASK;
    }
    return apiKey;
}

function maskHolder<T extends { apiKey?: string } | undefined>(holder: T): T {
    if (!holder || typeof holder !== 'object') return holder;
    return {
        ...holder,
        apiKey: maskSecretValue(holder.apiKey),
    };
}

function maskOpenAIBlock<T extends { instances?: OpenAIInstance[]; activeInstanceId?: string } | undefined>(
    openai: T,
): T {
    if (!openai || typeof openai !== 'object') return openai;
    return {
        ...openai,
        ...(Array.isArray(openai.instances)
            ? {
                instances: openai.instances.map((item) => ({
                    ...item,
                    apiKey: maskSecretValue(item.apiKey) ?? '',
                })),
            }
            : {}),
    };
}

function maskTextAiBlock(textAi: TextAiConfig | undefined): TextAiConfig | undefined {
    if (!textAi) return textAi;
    const masked: TextAiConfig = {
        ...textAi,
        ...(textAi.openai !== undefined ? { openai: maskOpenAIBlock(textAi.openai) } : {}),
        ...(textAi.gemini !== undefined ? { gemini: maskHolder(textAi.gemini) } : {}),
        ...(textAi.azure !== undefined ? { azure: maskHolder(textAi.azure) } : {}),
        ...(textAi.anthropic !== undefined ? { anthropic: maskHolder(textAi.anthropic) } : {}),
    };
    for (const id of VENDOR_PROVIDER_IDS) {
        if (textAi[id] !== undefined) {
            masked[id] = maskHolder(textAi[id]);
        }
    }
    return masked;
}

function maskTtsBlock(tts: TtsConfig | undefined): TtsConfig | undefined {
    if (!tts) return tts;
    const masked: TtsConfig = { ...tts };
    for (const id of CLOUD_TTS_PROVIDERS) {
        if (tts[id] !== undefined) {
            masked[id] = maskHolder(tts[id]);
        }
    }
    return masked;
}

/**
 * 脱敏返回给前端的设置响应，确保任何非空 apiKey 不以明文下发，同时不破坏原有对象引用。
 */
export function maskAppConfigSecrets<T extends Partial<AppConfig>>(config: T): T {
    const masked: Partial<AppConfig> = { ...config };
    if (config.gemini !== undefined) masked.gemini = maskHolder(config.gemini);
    if (config.azure !== undefined) masked.azure = maskHolder(config.azure);
    if (config.anthropic !== undefined) masked.anthropic = maskHolder(config.anthropic);
    if (config.openai !== undefined) masked.openai = maskOpenAIBlock(config.openai);

    for (const id of VENDOR_PROVIDER_IDS) {
        if (config[id] !== undefined) {
            masked[id] = maskHolder(config[id]);
        }
    }

    if (config.textAi !== undefined) {
        masked.textAi = maskTextAiBlock(config.textAi);
    }
    if (config.tts !== undefined) {
        masked.tts = maskTtsBlock(config.tts);
    }

    return masked as T;
}

function unmaskSecretWithFallback<T extends { apiKey?: string } | undefined>(
    incoming: T,
    primary: SecretHolder,
    fallback?: SecretHolder,
): T {
    if (!incoming || incoming.apiKey !== SECRET_MASK) {
        return incoming;
    }
    const resolved = primary?.apiKey || fallback?.apiKey || '';
    return { ...incoming, apiKey: resolved };
}

function unmaskOpenAIInstancesWithFallback(
    incoming: { instances?: OpenAIInstance[]; activeInstanceId?: string } | undefined,
    primary: { instances?: OpenAIInstance[]; activeInstanceId?: string } | undefined,
    fallback?: { instances?: OpenAIInstance[]; activeInstanceId?: string },
) {
    if (!incoming?.instances) return incoming;
    const primaryInstances = primary?.instances || [];
    const fallbackInstances = fallback?.instances || [];
    return {
        ...incoming,
        instances: incoming.instances.map((instance) => {
            if (instance.apiKey !== SECRET_MASK) return instance;
            const fromPrimary = primaryInstances.find((item) => item.id === instance.id)?.apiKey;
            const fromFallback = fallbackInstances.find((item) => item.id === instance.id)?.apiKey;
            return { ...instance, apiKey: fromPrimary || fromFallback || '' };
        }),
    };
}

type ProviderFieldsBag = Partial<Pick<AppConfig, 'openai' | 'gemini' | 'azure' | 'anthropic' | VendorProviderId>>;

function unmaskProviderScope<T extends ProviderFieldsBag>(
    incoming: T,
    primary: ProviderFieldsBag | undefined,
    fallback?: ProviderFieldsBag,
): T {
    const next: ProviderFieldsBag = { ...incoming };

    if ('openai' in incoming) {
        next.openai = unmaskOpenAIInstancesWithFallback(incoming.openai, primary?.openai, fallback?.openai);
    }
    if ('gemini' in incoming) {
        next.gemini = unmaskSecretWithFallback(incoming.gemini, primary?.gemini, fallback?.gemini);
    }
    if ('azure' in incoming) {
        next.azure = unmaskSecretWithFallback(incoming.azure, primary?.azure, fallback?.azure);
    }
    if ('anthropic' in incoming) {
        next.anthropic = unmaskSecretWithFallback(incoming.anthropic, primary?.anthropic, fallback?.anthropic);
    }
    for (const id of VENDOR_PROVIDER_IDS) {
        if (id in incoming) {
            next[id] = unmaskSecretWithFallback(incoming[id], primary?.[id], fallback?.[id]);
        }
    }

    return next as T;
}

/**
 * 在 POST /api/settings 保存前还原前端回传的掩码密钥；
 * 当首次关闭 textSameAsVision 且 textAi 尚未在库中持久化密钥时，回退从顶层 vision 配置读取真实密钥，
 * 防止把掩码覆盖为空串。仅保留 incoming 中显式传入的键。
 */
export function unmaskAppConfigSecrets<T extends Partial<AppConfig>>(incoming: T, current: AppConfig): T {
    const next = unmaskProviderScope(incoming, current);

    if (incoming.tts) {
        const nextTts: TtsConfig = { ...incoming.tts };
        for (const id of CLOUD_TTS_PROVIDERS) {
            if (incoming.tts[id] !== undefined) {
                nextTts[id] = unmaskSecretWithFallback(incoming.tts[id], current.tts?.[id]);
            }
        }
        next.tts = nextTts;
    }
    if (incoming.textAi) {
        next.textAi = unmaskProviderScope(incoming.textAi, current.textAi, current);
    }

    return next as T;
}

function findProviderKeyFromScope(
    scope: ProviderFieldsBag | TextAiConfig | undefined,
    provider: string,
    instanceId?: string,
): string | undefined {
    if (!scope) return undefined;
    if (provider === 'openai') {
        const instances = scope.openai?.instances ?? [];
        const targetId = instanceId || scope.openai?.activeInstanceId;
        if (targetId) {
            const matched = instances.find((item) => item.id === targetId)?.apiKey;
            if (matched) return matched;
        }
        return undefined;
    }
    if (provider === 'gemini') return scope.gemini?.apiKey || undefined;
    if (provider === 'azure') return scope.azure?.apiKey || undefined;
    if (provider === 'anthropic') return scope.anthropic?.apiKey || undefined;
    if (isVendorProvider(provider)) return scope[provider]?.apiKey || undefined;
    return undefined;
}

function findProviderConnFromScope(
    scope: ProviderFieldsBag | TextAiConfig | undefined,
    provider: string,
    instanceId?: string,
): { apiKey?: string; baseUrl?: string } | undefined {
    if (!scope) return undefined;
    if (provider === 'openai') {
        const targetId = instanceId || scope.openai?.activeInstanceId;
        const matched = targetId ? (scope.openai?.instances ?? []).find((item) => item.id === targetId) : undefined;
        return matched?.apiKey ? { apiKey: matched.apiKey, baseUrl: matched.baseUrl } : undefined;
    }
    const conn = provider === 'gemini' ? scope.gemini
        : provider === 'anthropic' ? scope.anthropic
            : isVendorProvider(provider) ? scope[provider]
                : undefined;
    return conn?.apiKey ? { apiKey: conn.apiKey, baseUrl: (conn as { baseUrl?: string }).baseUrl } : undefined;
}

/**
 * 供 /api/ai/models 使用：收到掩码时取已保存的密钥，以及与它一起保存的 Base URL。
 * 用已保存的密钥时只能请求已保存的地址，避免把密钥发到临时改过的地址上。
 */
export function resolveStoredProviderConn(
    params: { provider?: string; role?: AiModelRole; instanceId?: string },
    current: AppConfig | undefined,
): { apiKey: string; baseUrl?: string } | null {
    const { provider, role, instanceId } = params;
    if (!provider || !current) return null;
    const searchOrder = role === 'text' ? [current.textAi, current] : [current, current.textAi];
    for (const scope of searchOrder) {
        const conn = findProviderConnFromScope(scope, provider, instanceId);
        if (conn?.apiKey) return { apiKey: conn.apiKey, baseUrl: conn.baseUrl?.trim() || undefined };
    }
    return null;
}

/**
 * 供 /api/ai/test 与 /api/ai/models 使用：收到掩码 '********' 时按 role 与 instanceId 还原服务端真实密钥。
 * 对于 role='text' 且 textAi 尚未落库的场景，会自动回退查找 vision 顶层真实密钥。
 */
export function resolveTestApiKey(
    params: { provider?: string; apiKey?: string; role?: AiModelRole; instanceId?: string },
    current: AppConfig | undefined,
): string | undefined {
    const { provider, apiKey, role, instanceId } = params;
    if (apiKey !== SECRET_MASK) return apiKey;
    if (!provider || !current) return '';

    const searchOrder = role === 'text'
        ? [current.textAi, current]
        : [current, current.textAi];

    for (const scope of searchOrder) {
        const resolved = findProviderKeyFromScope(scope, provider, instanceId);
        if (resolved) return resolved;
    }
    return '';
}
