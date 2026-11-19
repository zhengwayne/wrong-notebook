/**
 * 多 AI 提供商统一错误归一化模块。
 * 将各官方 SDK（GoogleGenAI、OpenAI、AzureOpenAI、Anthropic）及网络/解析异常映射为统一的 AI_* 错误码。
 */
import { ZodError } from 'zod';
import { createLogger } from '../logger';
import { aiErrorCodeForStatus, classifyAiErrorText } from './error-text-classification';
import { AI_OUTPUT_TRUNCATED } from './truncation';

const logger = createLogger('ai:error');

const STANDARD_AI_ERROR_CODES = new Set([
    AI_OUTPUT_TRUNCATED,
    'AI_AUTH_ERROR',
    'AI_CONNECTION_FAILED',
    'AI_TIMEOUT_ERROR',
    'AI_QUOTA_EXCEEDED',
    'AI_PERMISSION_DENIED',
    'AI_NOT_FOUND',
    'AI_SERVICE_UNAVAILABLE',
    'AI_RESPONSE_ERROR',
    'AI_UNKNOWN_ERROR',
]);

function isStandardAiError(message: string): boolean {
    const prefix = message.split(':')[0]?.trim();
    return Boolean(prefix && STANDARD_AI_ERROR_CODES.has(prefix));
}

function readHttpStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const record = error as { status?: unknown; statusCode?: unknown };
    const status = typeof record.status === 'number'
        ? record.status
        : typeof record.statusCode === 'number'
            ? record.statusCode
            : undefined;
    return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function mapStatusToError(status: number, cause: unknown): Error | null {
    const code = aiErrorCodeForStatus(status);
    return code ? new Error(code, { cause }) : null;
}

/** 统一记录错误并抛出标准化 AI_* Error */
export function normalizeAiError(error: unknown, providerLabel: string): never {
    logger.error({ provider: providerLabel, error }, `${providerLabel} error`);

    if (error instanceof Error && isStandardAiError(error.message)) {
        throw error;
    }

    if (error instanceof ZodError) {
        throw new Error('AI_RESPONSE_ERROR', { cause: error });
    }

    const status = readHttpStatus(error);
    if (status !== undefined) {
        const mapped = mapStatusToError(status, error);
        if (mapped) throw mapped;
    }

    if (error instanceof Error) {
        const ctorName = error.constructor?.name;
        if (error.name === 'TimeoutError' || error.name === 'AbortError' || ctorName === 'APIConnectionTimeoutError') {
            throw new Error('AI_TIMEOUT_ERROR', { cause: error });
        }
        if (ctorName === 'APIConnectionError') {
            throw new Error('AI_CONNECTION_FAILED', { cause: error });
        }

        const code = classifyAiErrorText(error.message);
        if (code) throw new Error(code, { cause: error });
    }

    throw new Error('AI_UNKNOWN_ERROR', { cause: error });
}
