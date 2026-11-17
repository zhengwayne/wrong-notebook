import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth-utils";
import { getAppConfig, updateAppConfig } from "@/lib/config";
import { isValidConcurrencyLimit } from "@/lib/ai-concurrency-limit";
import { badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import type { OpenAIInstance } from "@/types/api";
import { isValidTimeZone } from "@/lib/date-time";
import { VENDOR_PROVIDER_IDS } from "@/lib/ai/vendor-presets";
import type { TextAiConfig } from "@/types/api";
import { CLOUD_TTS_PROVIDERS, TTS_MODES } from "@/lib/tts/constants";
import { getSecurityPosture } from "@/lib/security-posture";
import { defineApiRoute } from "@/lib/server/api-route";

const logger = createLogger('api:settings');

const minimaxCodeSchema = z.object({
    model: z.string().trim().max(100).optional(),
    autoCheckin: z.boolean().optional(),
});

const cloudTtsSchema = z.object({
    model: z.string().trim().max(100).optional(),
    voice: z.string().trim().max(200).optional(),
    endpoint: z.union([z.literal(''), z.string().trim().url().max(500)]).optional(),
    apiKey: z.string().trim().max(500).optional(),
});

const ttsSchema = z.object({
    mode: z.enum(TTS_MODES).optional(),
    ...Object.fromEntries(CLOUD_TTS_PROVIDERS.map((id) => [id, cloudTtsSchema.optional()])),
});


function unmaskSecret<T extends { apiKey?: string } | undefined>(incoming: T, current: T): T {
    if (incoming && incoming.apiKey === '********') {
        return { ...incoming, apiKey: current?.apiKey || '' };
    }
    return incoming;
}

function unmaskOpenAIInstances(
    incoming: { instances?: OpenAIInstance[]; activeInstanceId?: string } | undefined,
    current: { instances?: OpenAIInstance[]; activeInstanceId?: string } | undefined,
) {
    if (!incoming?.instances) return incoming;
    const currentInstances = current?.instances || [];
    return {
        ...incoming,
        instances: incoming.instances.map((instance) => {
            if (instance.apiKey !== '********') return instance;
            const original = currentInstances.find((item) => item.id === instance.id);
            return { ...instance, apiKey: original?.apiKey || '' };
        }),
    };
}

function unmaskTextAi(incoming: TextAiConfig | undefined, current: TextAiConfig | undefined): TextAiConfig | undefined {
    if (!incoming) return incoming;
    const next: TextAiConfig = {
        ...incoming,
        openai: unmaskOpenAIInstances(incoming.openai, current?.openai),
        gemini: unmaskSecret(incoming.gemini, current?.gemini),
        azure: unmaskSecret(incoming.azure, current?.azure),
        anthropic: unmaskSecret(incoming.anthropic, current?.anthropic),
    };
    for (const id of VENDOR_PROVIDER_IDS) {
        next[id] = unmaskSecret(incoming[id], current?.[id]);
    }
    return next;
}

export const dynamic = 'force-dynamic';

export const GET = defineApiRoute({ auth: 'user' }, async (_req, { user }) => {
    const config = getAppConfig();
    // 完整配置（含 API Key 与管理员安全态势提醒）只给管理员；普通用户只需要页面用到的非敏感字段
    if (!isAdmin(user)) {
        return NextResponse.json({ aiProvider: config.aiProvider, timeouts: config.timeouts, timeZone: config.timeZone });
    }
    return NextResponse.json({ ...config, securityPosture: getSecurityPosture(config) });
});

export const POST = defineApiRoute({ auth: 'admin' }, async (req) => {
    try {
        const body = await req.json();
        if (body.timeZone !== undefined) {
            if (!isValidTimeZone(body.timeZone)) return badRequest('INVALID_TIME_ZONE');
            body.timeZone = body.timeZone.trim();
        }
        if (body.aiDailyLimit !== undefined && !(Number.isInteger(body.aiDailyLimit) && body.aiDailyLimit >= 0)) {
            return badRequest('INVALID_AI_DAILY_LIMIT');
        }
        if (body.aiConcurrencyLimit !== undefined && !isValidConcurrencyLimit(body.aiConcurrencyLimit)) {
            return badRequest('INVALID_AI_CONCURRENCY_LIMIT');
        }
        if (body.minimaxCode !== undefined) {
            const parsed = minimaxCodeSchema.safeParse(body.minimaxCode);
            if (!parsed.success) return badRequest('INVALID_MINIMAX_CODE_CONFIG');
            // 只保存模型和自动签到开关；登录凭据与签到记录由服务端单独管理
            body.minimaxCode = parsed.data;
        }
        if (body.tts !== undefined) {
            const parsed = ttsSchema.safeParse(body.tts);
            if (!parsed.success) return badRequest('INVALID_TTS_CONFIG');
            body.tts = parsed.data;
        }
        const currentConfig = getAppConfig();

        body.gemini = unmaskSecret(body.gemini, currentConfig.gemini);
        body.openai = unmaskOpenAIInstances(body.openai, currentConfig.openai);
        body.azure = unmaskSecret(body.azure, currentConfig.azure);
        body.anthropic = unmaskSecret(body.anthropic, currentConfig.anthropic);
        for (const id of VENDOR_PROVIDER_IDS) {
            body[id] = unmaskSecret(body[id], currentConfig[id]);
        }
        for (const id of CLOUD_TTS_PROVIDERS) {
            if (body.tts?.[id]) {
                body.tts[id] = unmaskSecret(body.tts[id], currentConfig.tts?.[id]);
            }
        }
        if (body.textAi) {
            body.textAi = unmaskTextAi(body.textAi, currentConfig.textAi);
        }

        const updatedConfig = updateAppConfig(body);
        return NextResponse.json(updatedConfig);
    } catch (error) {
        logger.error({ error }, 'Failed to update settings');
        return internalError("Failed to update settings");
    }
});


