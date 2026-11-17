import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth-utils";
import { getAppConfig, updateAppConfig } from "@/lib/config";
import { isValidConcurrencyLimit } from "@/lib/ai-concurrency-limit";
import { badRequest, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import type { AppConfig, TextAiConfig } from "@/types/api";
import { isValidTimeZone } from "@/lib/date-time";
import { VENDOR_PROVIDER_IDS } from "@/lib/ai/vendor-presets";
import { assertSafeOutboundUrl, OutboundUrlError } from "@/lib/outbound-url";
import { maskAppConfigSecrets, unmaskAppConfigSecrets } from "@/lib/settings-secrets";
import { CLOUD_TTS_PROVIDERS, TTS_MODES } from "@/lib/tts/constants";
import { buildDataFlowSummary } from "@/lib/data-flow";
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

function validateUrlField(rawUrl: unknown): void {
    if (typeof rawUrl !== 'string') return;
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    assertSafeOutboundUrl(trimmed);
}

function validateScopeOutboundUrls(scope: Pick<Partial<AppConfig>, 'gemini' | 'anthropic' | 'azure' | 'openai'> & Record<string, unknown>): void {
    validateUrlField(scope.gemini?.baseUrl);
    validateUrlField(scope.anthropic?.baseUrl);
    validateUrlField(scope.azure?.endpoint);
    if (Array.isArray(scope.openai?.instances)) {
        for (const instance of scope.openai.instances) {
            validateUrlField(instance?.baseUrl);
        }
    }
    for (const id of VENDOR_PROVIDER_IDS) {
        const vendor = scope[id] as { baseUrl?: unknown } | undefined;
        validateUrlField(vendor?.baseUrl);
    }
}

export const dynamic = 'force-dynamic';

export const GET = defineApiRoute({ auth: 'user' }, async (_req, { user }) => {
    const config = getAppConfig();
    const dataFlow = buildDataFlowSummary(config);
    // 完整配置（含安全态势摘要，所有密钥字段脱敏）只给管理员；普通用户只需要非敏感字段与脱敏数据去向摘要
    if (!isAdmin(user)) {
        return NextResponse.json({ aiProvider: config.aiProvider, timeouts: config.timeouts, timeZone: config.timeZone, dataFlow });
    }
    return NextResponse.json({ ...maskAppConfigSecrets(config), securityPosture: getSecurityPosture(config), dataFlow });
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
        try {
            validateScopeOutboundUrls(body);
            if (body.textAi) {
                validateScopeOutboundUrls(body.textAi as TextAiConfig & Record<string, unknown>);
            }
            for (const id of CLOUD_TTS_PROVIDERS) {
                validateUrlField(body.tts?.[id]?.endpoint);
            }
        } catch (err) {
            if (err instanceof OutboundUrlError) {
                return badRequest('INVALID_OUTBOUND_URL');
            }
            throw err;
        }

        const currentConfig = getAppConfig();
        const unmaskedBody = unmaskAppConfigSecrets(body as Partial<AppConfig>, currentConfig);

        const updatedConfig = updateAppConfig(unmaskedBody);
        return NextResponse.json(maskAppConfigSecrets(updatedConfig));
    } catch (error) {
        logger.error({ error }, 'Failed to update settings');
        return internalError("Failed to update settings");
    }
});


