import { getConfigForRole, isTextSameAsVision } from "@/lib/ai/roles";
import { VENDOR_PRESETS, type VendorProviderId } from "@/lib/ai/vendor-presets";
import { isCloudTtsProvider } from "@/lib/tts/constants";
import { normalizeHttpBaseUrl } from "@/lib/utils";
import type { AppConfig, DataFlowSummary, EndpointLocality, ModelDataFlow } from "@/types/api";

const OFFICIAL_ENDPOINT_ORIGINS: Record<string, string> = {
    gemini: "https://generativelanguage.googleapis.com",
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    "minimax-code": "https://agent.minimax.cn",
    ...Object.fromEntries(
        (Object.entries(VENDOR_PRESETS) as Array<[VendorProviderId, (typeof VENDOR_PRESETS)[VendorProviderId]]>).map(
            ([id, preset]) => [id, new URL(preset.baseUrl).origin],
        ),
    ),
};

function isPrivateOrLocalHostname(hostname: string): boolean {
    const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!clean) return false;
    if (clean === "localhost" || clean.endsWith(".local") || clean === "::1") return true;
    if (clean.startsWith("fe80:") || clean.startsWith("fc") || clean.startsWith("fd")) return true;

    const ipv4 = clean.split(".");
    if (ipv4.length === 4 && ipv4.every((part) => /^\d+$/.test(part))) {
        const [a, b] = ipv4.map(Number);
        if (a === 127 || a === 10 || a === 0) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
    }
    return false;
}

function classifyUrl(provider: string, rawUrl: string | undefined): EndpointLocality {
    const trimmed = rawUrl?.trim();
    if (!trimmed) return "official";
    try {
        const normalized = normalizeHttpBaseUrl(trimmed);
        const parsed = new URL(normalized);
        if (OFFICIAL_ENDPOINT_ORIGINS[provider] === parsed.origin) {
            return "official";
        }
        return isPrivateOrLocalHostname(parsed.hostname) ? "local" : "custom_remote";
    } catch {
        return "custom_remote";
    }
}

function activeRoleUrl(view: AppConfig): string | undefined {
    const provider = view.aiProvider;
    if (provider === "minimax-code") return undefined;
    if (provider === "gemini") return view.gemini?.baseUrl;
    if (provider === "anthropic") return view.anthropic?.baseUrl;
    if (provider === "azure") return view.azure?.endpoint;
    if (provider === "openai") {
        const instances = view.openai?.instances ?? [];
        const active = instances.find((inst) => inst.id === view.openai?.activeInstanceId) ?? instances[0];
        return active?.baseUrl;
    }
    return view[provider]?.baseUrl;
}

function summarizeRole(config: AppConfig, role: "vision" | "text"): ModelDataFlow {
    const view = getConfigForRole(config, role);
    return {
        provider: view.aiProvider,
        endpointType: classifyUrl(view.aiProvider, activeRoleUrl(view)),
    };
}

/**
 * 构造面向全体用户（含非管理员）的 AI 与语音数据去向摘要：
 * 仅暴露提供商代号与端点性质（官方云端 / 本地模型 / 自定义远程），绝不泄露私有地址与密钥。
 */
export function buildDataFlowSummary(config: AppConfig): DataFlowSummary {
    const vision = summarizeRole(config, "vision");
    const sameAsVision = isTextSameAsVision(config);
    const text = sameAsVision ? vision : summarizeRole(config, "text");

    const mode = isCloudTtsProvider(config.tts?.mode) ? config.tts!.mode! : "browser";
    let ttsEndpointType: DataFlowSummary["tts"]["endpointType"] = "browser";
    if (mode !== "browser") {
        const ttsSpecificEndpoint = config.tts?.[mode]?.endpoint;
        const fallbackRoleUrl =
            mode === "openai"
                ? activeRoleUrl({ ...config, aiProvider: "openai" })
                : mode === "volcengine" || mode === "volcengine-agent" || mode === "minimax" || mode === "qwen" || mode === "glm" || mode === "stepfun"
                    ? config[mode]?.baseUrl
                    : undefined;
        ttsEndpointType = classifyUrl(mode, ttsSpecificEndpoint || fallbackRoleUrl);
    }

    return {
        vision,
        textSameAsVision: sameAsVision,
        text,
        tts: {
            mode,
            isCloud: mode !== "browser",
            endpointType: ttsEndpointType,
        },
    };
}
