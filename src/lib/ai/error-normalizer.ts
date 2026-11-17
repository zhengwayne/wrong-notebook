/**
 * 多 AI 提供商统一错误归一化模块。
 * 将各官方 SDK（GoogleGenAI、OpenAI、AzureOpenAI、Anthropic）及网络/解析异常映射为统一的 AI_* 错误码。
 */
import { ZodError } from 'zod';
import { createLogger } from '../logger';
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
    if (status === 401) return new Error('AI_AUTH_ERROR', { cause });
    if (status === 403) return new Error('AI_PERMISSION_DENIED', { cause });
    if (status === 404) return new Error('AI_NOT_FOUND', { cause });
    if (status === 408) return new Error('AI_TIMEOUT_ERROR', { cause });
    if (status === 429) return new Error('AI_QUOTA_EXCEEDED', { cause });
    if (status >= 500) return new Error('AI_SERVICE_UNAVAILABLE', { cause });
    return null;
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

        const msg = error.message.toLowerCase();
        if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect') || msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound')) {
            throw new Error('AI_CONNECTION_FAILED', { cause: error });
        }
        if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408') || msg.includes('etimedout')) {
            throw new Error('AI_TIMEOUT_ERROR', { cause: error });
        }
        if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
            throw new Error('AI_QUOTA_EXCEEDED', { cause: error });
        }
        if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
            throw new Error('AI_PERMISSION_DENIED', { cause: error });
        }
        if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
            throw new Error('AI_NOT_FOUND', { cause: error });
        }
        if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('529') || msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
            throw new Error('AI_SERVICE_UNAVAILABLE', { cause: error });
        }
        if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
            throw new Error('AI_AUTH_ERROR', { cause: error });
        }
        if (
            msg.includes('invalid json') ||
            msg.includes('parse') ||
            msg.includes('json') ||
            msg.includes('syntaxerror') ||
            msg.includes('missing critical xml') ||
            msg.includes('empty response') ||
            msg.includes('unexpected token')
        ) {
            throw new Error('AI_RESPONSE_ERROR', { cause: error });
        }
    }

    throw new Error('AI_UNKNOWN_ERROR', { cause: error });
}
