import { VENDOR_PROVIDER_IDS } from "@/lib/ai/vendor-presets";
import type { AppConfig, TextAiConfig } from "@/types/api";

/** 多模态（识图）与文本对话两类模型角色 */
export type AiModelRole = "vision" | "text";

/** 旧配置未写 textSameAsVision 时，文本角色复用多模态配置，避免已有用户中断 */
export function isTextSameAsVision(config: Pick<AppConfig, "textSameAsVision">): boolean {
    return config.textSameAsVision !== false;
}

/** 把当前多模态渠道配置复制一份，作为文本角色的初始值（关闭「相同配置」时用） */
export function snapshotVisionAsTextAi(config: AppConfig): TextAiConfig {
    return {
        openai: {
            instances: (config.openai?.instances ?? []).map((instance) => ({ ...instance })),
            activeInstanceId: config.openai?.activeInstanceId,
        },
        gemini: { ...config.gemini },
        azure: { ...config.azure },
        anthropic: { ...config.anthropic },
        minimaxCode: { ...config.minimaxCode },
        ...Object.fromEntries(VENDOR_PROVIDER_IDS.map((id) => [id, { ...config[id] }])),
    };
}

function overlayVendors(target: AppConfig, source: TextAiConfig | undefined): void {
    for (const id of VENDOR_PROVIDER_IDS) {
        if (source?.[id]) target[id] = source[id];
        else delete target[id];
    }
}

/**
 * 得到某一角色下「看起来像旧版单渠道 AppConfig」的视图，
 * 以便复用渠道表单、连接测试和 getAIService 的创建逻辑。
 */
export function getConfigForRole(config: AppConfig, role: AiModelRole): AppConfig {
    if (role === "vision" || isTextSameAsVision(config)) {
        return config;
    }
    const text = config.textAi ?? {};
    const view: AppConfig = {
        ...config,
        aiProvider: config.aiTextProvider ?? config.aiProvider,
        openai: text.openai ?? { instances: [], activeInstanceId: undefined },
        gemini: text.gemini ?? {},
        azure: text.azure ?? {},
        anthropic: text.anthropic ?? {},
        minimaxCode: text.minimaxCode ?? {},
    };
    overlayVendors(view, text);
    return view;
}

/** 从角色视图写回 AppConfig 的文本角色字段 */
export function applyTextRoleConfig(config: AppConfig, view: AppConfig): AppConfig {
    return {
        ...config,
        textSameAsVision: false,
        aiTextProvider: view.aiProvider,
        textAi: {
            openai: view.openai,
            gemini: view.gemini,
            azure: view.azure,
            anthropic: view.anthropic,
            minimaxCode: view.minimaxCode,
            ...Object.fromEntries(VENDOR_PROVIDER_IDS.map((id) => [id, view[id]])),
        },
    };
}

export function mergeTextAi(base: TextAiConfig | undefined, override: TextAiConfig | undefined): TextAiConfig | undefined {
    if (!base && !override) return undefined;
    return {
        openai: {
            instances: override?.openai?.instances ?? base?.openai?.instances ?? [],
            activeInstanceId: override?.openai?.activeInstanceId ?? base?.openai?.activeInstanceId,
        },
        gemini: { ...base?.gemini, ...override?.gemini },
        azure: { ...base?.azure, ...override?.azure },
        anthropic: { ...base?.anthropic, ...override?.anthropic },
        minimaxCode: { ...base?.minimaxCode, ...override?.minimaxCode },
        ...Object.fromEntries(VENDOR_PROVIDER_IDS.map((id) => [id, { ...base?.[id], ...override?.[id] }])),
    };
}
