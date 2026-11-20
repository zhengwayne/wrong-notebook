import { VENDOR_PROVIDER_IDS, type VendorProviderId } from "@/lib/ai/vendor-presets";
import { readMiniMaxCodeState } from "@/lib/minimax-code/store";
import type { AppConfig, TextAiConfig } from "@/types/api";

export interface AiReadinessSummary {
    ready: boolean;
    visionReady: boolean;
    textReady: boolean;
    visionProvider: string;
}

function hasKey(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

function isProviderReady(
    provider: string,
    scope: Pick<Partial<AppConfig>, "gemini" | "openai" | "azure" | "anthropic" | "minimaxCode"> & Record<string, unknown>,
): boolean {
    if (provider === "gemini") return hasKey(scope.gemini?.apiKey);
    if (provider === "anthropic") return hasKey(scope.anthropic?.apiKey);
    if (provider === "azure") {
        return hasKey(scope.azure?.apiKey) && hasKey(scope.azure?.endpoint) && hasKey(scope.azure?.deploymentName);
    }
    if (provider === "openai") {
        const instances = scope.openai?.instances ?? [];
        const activeId = scope.openai?.activeInstanceId;
        if (!activeId || instances.length === 0) return false;
        const active = instances.find((item) => item.id === activeId);
        return Boolean(active && hasKey(active.apiKey));
    }
    if (provider === "minimax-code") {
        const account = readMiniMaxCodeState().account;
        return Boolean(account && !account.invalid && hasKey(account.accessToken));
    }
    if ((VENDOR_PROVIDER_IDS as readonly string[]).includes(provider)) {
        const vendor = scope[provider as VendorProviderId] as { apiKey?: unknown } | undefined;
        return hasKey(vendor?.apiKey);
    }
    return false;
}

/**
 * 计算全局 AI 配置的脱敏就绪状态（绝不包含密钥、端点地址等敏感字段），
 * 让非管理员教师进入批改工作台时能直观获知 AI 是否开箱可用。
 */
export function computeAiReadiness(config: AppConfig): AiReadinessSummary {
    const visionProvider = config.aiProvider || "minimax";
    const visionReady = isProviderReady(visionProvider, config as AppConfig & Record<string, unknown>);

    const textSame = config.textSameAsVision !== false;
    const textProvider = textSame ? visionProvider : (config.aiTextProvider || visionProvider);
    const textScope = textSame
        ? (config as AppConfig & Record<string, unknown>)
        : ((config.textAi || {}) as TextAiConfig & Record<string, unknown>);
    const textReady = textSame ? visionReady : isProviderReady(textProvider, textScope);

    return {
        ready: visionReady && textReady,
        visionReady,
        textReady,
        visionProvider,
    };
}
