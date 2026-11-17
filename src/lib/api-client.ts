import { toast } from "@/lib/feedback";
import { translations } from "@/lib/translations";

type RequestOptions = RequestInit & {
    params?: Record<string, string>;
    timeout?: number; // 超时时间（毫秒），默认 60000
    /**
     * 耗时请求（AI 生成等）设为 true：附带请求编号，请求被浏览器中断（如 iPhone 上的 Safari 等待较久时）后
     * 改为轮询 /api/requests/:id 取回服务端的响应，对应路由需用 withRecoverableResponse 包装
     */
    recoverable?: boolean;
};

export class ApiError extends Error {
    public code?: string;

    constructor(public status: number, public statusText: string, public data: unknown, code?: string) {
        super(`API Error: ${status} ${statusText}`);
        this.name = 'ApiError';
        this.code = code ?? extractErrorCode(data);
    }
}

function extractErrorCode(data: unknown): string | undefined {
    if (typeof data !== 'object' || data === null) return undefined;
    const record = data as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code) return record.code;
    if (typeof record.error === 'string' && record.error) return record.error;
    return undefined;
}

const SESSION_REVOKED_DEBOUNCE_MS = 3000;
const REVOKED_CODES = new Set(['SESSION_REVOKED', 'ACCOUNT_DISABLED']);
type SessionRevokedHandler = (code: string) => void | Promise<void>;
let customSessionRevokedHandler: SessionRevokedHandler | null = null;
let lastRevokedSignOutAt = -Infinity;

/** 仅用于单测：注入会话撤销/账户禁用回调并重置防抖窗口 */
export function setOnSessionRevokedForTest(handler: SessionRevokedHandler | null) {
    customSessionRevokedHandler = handler;
    lastRevokedSignOutAt = -Infinity;
}

function triggerSessionRevokedSignOut(code: string) {
    const now = Date.now();
    if (now - lastRevokedSignOutAt < SESSION_REVOKED_DEBOUNCE_MS) return;
    lastRevokedSignOutAt = now;
    if (customSessionRevokedHandler) {
        void customSessionRevokedHandler(code);
        return;
    }
    if (typeof window !== 'undefined') {
        void import('next-auth/react')
            .then(({ signOut }) => signOut({ callbackUrl: '/login' }))
            .catch(() => undefined);
    }
}

/**
 * 每日 AI 次数用完时统一提示，各个 AI 按钮无需单独处理；
 * 语言与界面一致（LanguageContext 保存在 localStorage 中）。
 */
function notifyAiDailyLimit(data: unknown) {
    if (typeof data !== 'object' || data === null || !('code' in data) || data.code !== 'AI_DAILY_LIMIT_EXCEEDED') return;
    let language: keyof typeof translations = 'zh';
    try {
        if (localStorage.getItem('app-language') === 'en') language = 'en';
    } catch {
        // 无法读取时使用默认语言
    }
    toast.warning(translations[language].errors.AI_DAILY_LIMIT_EXCEEDED);
}

/** 断线后轮询结果的间隔 */
const RECOVERY_POLL_MS = 3000;
/** 断线后多久仍查不到请求，视为请求没有到达服务端 */
const RECOVERY_GRACE_MS = 6000;

/** 随机请求编号（32 位十六进制）；局域网 HTTP 访问不是安全上下文，不能用 randomUUID */
function createRequestId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** fetch 没有收到响应（网络中断）时抛出 TypeError；服务端返回的错误和超时不算 */
export function isNetworkError(error: unknown): boolean {
    return error instanceof TypeError;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 请求被中断后轮询服务端暂存的响应，直到请求结束或超过原定的超时时间；
 * 查不到请求时抛出原来的网络错误
 */
async function recoverResponse<T>(requestId: string, deadline: number, originalError: unknown): Promise<T> {
    const lostAt = Date.now();
    while (Date.now() < deadline) {
        let stored: { state: 'running' } | { state: 'done'; status: number; body: unknown } | null = null;
        try {
            stored = await request(`/api/requests/${requestId}`, { method: 'GET', timeout: 15000 });
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                if (Date.now() - lostAt > RECOVERY_GRACE_MS) throw originalError;
            }
            // 其他错误（网络仍不稳定等）稍后重试
        }
        if (stored?.state === 'done') {
            if (stored.status >= 200 && stored.status < 300) return (stored.body ?? {}) as T;
            if (stored.status === 429) notifyAiDailyLimit(stored.body);
            throw new ApiError(stored.status, '', stored.body);
        }
        await sleep(RECOVERY_POLL_MS);
    }
    throw new ApiError(408, 'Request Timeout', { message: 'AI_TIMEOUT_ERROR' });
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const { params, headers, timeout = 60000, recoverable, signal: externalSignal, ...rest } = options;
    const requestId = recoverable ? createRequestId() : null;
    const startedAt = Date.now();

    let finalUrl = url;
    if (params) {
        const searchParams = new URLSearchParams(params);
        finalUrl += `?${searchParams.toString()}`;
    }

    const hasBody = rest.body !== undefined && rest.body !== null;
    const isBinaryOrForm = (typeof FormData !== 'undefined' && rest.body instanceof FormData)
        || (typeof Blob !== 'undefined' && rest.body instanceof Blob)
        || (typeof URLSearchParams !== 'undefined' && rest.body instanceof URLSearchParams);
    const mergedHeaders: HeadersInit = {
        ...(hasBody && !isBinaryOrForm ? { 'Content-Type': 'application/json' } : {}),
        ...(requestId ? { 'X-Request-Id': requestId } : {}),
        ...headers,
    };

    const timeoutController = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(new DOMException('Request Timeout', 'TimeoutError'));
    }, timeout);

    let signal: AbortSignal = timeoutController.signal;
    let cleanupSignalListener: (() => void) | undefined;
    if (externalSignal) {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
            signal = AbortSignal.any([timeoutController.signal, externalSignal]);
        } else {
            if (externalSignal.aborted) {
                timeoutController.abort(externalSignal.reason);
            } else {
                const forwardAbort = () => timeoutController.abort(externalSignal.reason);
                externalSignal.addEventListener('abort', forwardAbort, { once: true });
                cleanupSignalListener = () => externalSignal.removeEventListener('abort', forwardAbort);
            }
        }
    }

    try {
        const res = await fetch(finalUrl, {
            ...rest,
            headers: mergedHeaders,
            signal,
        });
        clearTimeout(timeoutId);
        cleanupSignalListener?.();

        if (res.status === 204) {
            return {} as T;
        }

        const rawText = await res.text();
        const trimmed = rawText.trim();
        let parsedBody: unknown = undefined;
        let isJson = false;
        if (trimmed.length > 0) {
            try {
                parsedBody = JSON.parse(trimmed);
                isJson = true;
            } catch {
                parsedBody = rawText;
            }
        }

        if (!res.ok) {
            const errorData = trimmed.length === 0 ? '' : parsedBody;
            const code = extractErrorCode(errorData);
            if (res.status === 429) notifyAiDailyLimit(errorData);
            if (res.status === 401 && code && REVOKED_CODES.has(code)) {
                triggerSessionRevokedSignOut(code);
            }
            throw new ApiError(res.status, res.statusText, errorData, code);
        }

        if (trimmed.length === 0) {
            return {} as T;
        }
        if (!isJson) {
            throw new ApiError(
                res.status || 502,
                res.statusText || 'Invalid JSON response',
                { code: 'INVALID_JSON_RESPONSE', message: 'Expected JSON response body', rawText: rawText.slice(0, 200) },
                'INVALID_JSON_RESPONSE',
            );
        }
        return parsedBody as T;
    } catch (error) {
        clearTimeout(timeoutId);
        cleanupSignalListener?.();
        if (externalSignal?.aborted && !timedOut) {
            throw error;
        }
        if (
            timedOut
            || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
        ) {
            throw new ApiError(408, 'Request Timeout', {
                message: 'AI_TIMEOUT_ERROR',
            });
        }
        if (requestId && isNetworkError(error)) {
            return recoverResponse<T>(requestId, startedAt + timeout, error);
        }
        throw error;
    }
}

export const apiClient = {
    get: <T>(url: string, options?: RequestOptions) => request<T>(url, { ...options, method: 'GET' }),
    post: <TResponse, TBody = unknown>(url: string, body?: TBody, options?: RequestOptions) => request<TResponse>(url, {
        ...options,
        method: 'POST',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    put: <TResponse, TBody = unknown>(url: string, body?: TBody, options?: RequestOptions) => request<TResponse>(url, {
        ...options,
        method: 'PUT',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    patch: <TResponse, TBody = unknown>(url: string, body?: TBody, options?: RequestOptions) => request<TResponse>(url, {
        ...options,
        method: 'PATCH',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    delete: <T>(url: string, options?: RequestOptions) => request<T>(url, { ...options, method: 'DELETE' }),
};
