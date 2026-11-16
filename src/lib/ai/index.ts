import { AIService } from "./types";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import { AzureOpenAIProvider } from "./azure-provider";
import { AnthropicProvider } from "./anthropic-provider";
import { MiniMaxCodeProvider } from "./minimax-code-provider";
import { isVendorProvider, resolveVendorConfig, VENDOR_PRESETS } from "./vendor-presets";
import { limitModelConcurrency } from "./concurrency";
import { getConfigForRole, type AiModelRole } from "./roles";

export * from "./types";
export type { AiModelRole } from "./roles";
export { getConfigForRole, isTextSameAsVision, snapshotVisionAsTextAi, applyTextRoleConfig } from "./roles";

import { getAppConfig } from "../config";
import type { AppConfig, OpenAIInstance } from "../config";
import { createLogger } from "../logger";

const logger = createLogger('ai');

/** 并发限制的分组键：同一渠道、地址和模型共用一组名额 */
function concurrencyKey(provider: string, baseUrl: string | undefined, model: string | undefined): string {
    return [provider, baseUrl || '', model || ''].join('|');
}

function getActiveInstance(config: AppConfig): OpenAIInstance | undefined {
    const instances = config.openai?.instances || [];
    const activeId = config.openai?.activeInstanceId;
    if (!activeId || instances.length === 0) return undefined;
    return instances.find((item) => item.id === activeId);
}

/** 按角色返回当前配置的 AI 服务；文本角色在未单独配置时复用多模态配置 */
export function getAIService(role: AiModelRole): AIService {
    const { service, key } = createAIService(getConfigForRole(getAppConfig(), role));
    return limitModelConcurrency(service, key);
}

function createAIService(config: AppConfig): { service: AIService; key: string } {
    const provider = config.aiProvider;

    if (provider === "openai") {
        const activeConfig = getActiveInstance(config);
        logger.info({ activeInstance: activeConfig?.name }, 'Using OpenAI Provider');
        return { service: new OpenAIProvider(activeConfig), key: concurrencyKey(provider, activeConfig?.baseUrl, activeConfig?.model) };
    } else if (provider === "azure") {
        logger.info({ deployment: config.azure?.deploymentName }, 'Using Azure OpenAI Provider');
        return { service: new AzureOpenAIProvider(config.azure), key: concurrencyKey(provider, config.azure?.endpoint, config.azure?.deploymentName) };
    } else if (provider === "anthropic") {
        logger.info({ model: config.anthropic?.model }, 'Using Anthropic Provider');
        return { service: new AnthropicProvider(config.anthropic), key: concurrencyKey(provider, config.anthropic?.baseUrl, config.anthropic?.model) };
    } else if (provider === "minimax-code") {
        logger.info({ model: config.minimaxCode?.model }, 'Using MiniMax Code OAuth Provider');
        return { service: new MiniMaxCodeProvider(config.minimaxCode), key: concurrencyKey(provider, undefined, config.minimaxCode?.model) };
    } else if (provider === "gemini") {
        logger.info('Using Gemini Provider');
        return { service: new GeminiProvider(config.gemini), key: concurrencyKey(provider, config.gemini?.baseUrl, config.gemini?.model) };
    } else {
        // 国产大模型官方渠道；未知取值回退到默认的 MiniMax
        const vendor = isVendorProvider(provider) ? provider : 'minimax';
        const vendorConfig = resolveVendorConfig(vendor, config[vendor]);
        logger.info({ vendor: VENDOR_PRESETS[vendor].name, model: vendorConfig.model }, 'Using vendor provider (OpenAI compatible)');
        return { service: new OpenAIProvider(vendorConfig), key: concurrencyKey(vendor, vendorConfig.baseUrl, vendorConfig.model) };
    }
}
