/**
 * 按错误原文归类 AI 错误码（前后端共用，不要引入服务端模块）。
 * 服务端归一化 SDK 异常时使用；前端遇到任务里保存的服务商原文（如「401 Authentication Fails…」）时也用它翻译。
 *
 * 连接中断关键词与开头状态码规则 ported from margrop/wrong-notebook f89d8a0a、49121588 (MIT)。
 */

export type AiErrorTextCode =
    | 'AI_AUTH_ERROR'
    | 'AI_CONNECTION_FAILED'
    | 'AI_TIMEOUT_ERROR'
    | 'AI_QUOTA_EXCEEDED'
    | 'AI_PERMISSION_DENIED'
    | 'AI_NOT_FOUND'
    | 'AI_SERVICE_UNAVAILABLE'
    | 'AI_RESPONSE_ERROR';

/** HTTP 状态码对应的错误码 */
export function aiErrorCodeForStatus(status: number): AiErrorTextCode | null {
    if (status === 401) return 'AI_AUTH_ERROR';
    if (status === 403) return 'AI_PERMISSION_DENIED';
    if (status === 404) return 'AI_NOT_FOUND';
    if (status === 408) return 'AI_TIMEOUT_ERROR';
    if (status === 429) return 'AI_QUOTA_EXCEEDED';
    if (status >= 500 && status <= 599) return 'AI_SERVICE_UNAVAILABLE';
    return null;
}

// SDK 把状态码放在消息开头，如「401 Authentication Fails, Your api key …」「429 Too Many Requests」
const LEADING_STATUS = /^\s*(?:error[:\s]+)?(\d{3})\b/i;

/** 按错误原文归类；无法判断时返回 null */
export function classifyAiErrorText(message: string): AiErrorTextCode | null {
    if (!message) return null;
    // 开头的状态码最可靠，先于关键词判断，避免 request_id 里的数字（如 …502…）造成误判
    const leading = LEADING_STATUS.exec(message);
    if (leading) {
        const byStatus = aiErrorCodeForStatus(Number(leading[1]));
        if (byStatus) return byStatus;
    }

    const msg = message.toLowerCase();
    // 网络/连接错误：undici 在连接中断时抛 TypeError「terminated」，另有 socket hang up 等
    if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect') || msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('enotfound')
        || msg.includes('terminated') || msg.includes('socket hang up') || msg.includes('other side closed') || msg.includes('epipe')) {
        return 'AI_CONNECTION_FAILED';
    }
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408') || msg.includes('etimedout')) {
        return 'AI_TIMEOUT_ERROR';
    }
    if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
        return 'AI_QUOTA_EXCEEDED';
    }
    if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
        return 'AI_PERMISSION_DENIED';
    }
    if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
        return 'AI_NOT_FOUND';
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('529') || msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
        return 'AI_SERVICE_UNAVAILABLE';
    }
    if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401') || msg.includes('authentication fail')) {
        return 'AI_AUTH_ERROR';
    }
    if (
        msg.includes('invalid json') ||
        msg.includes('parse') ||
        msg.includes('json') ||
        msg.includes('syntaxerror') ||
        msg.includes('missing critical xml') ||
        msg.includes('invalid ai response') ||
        msg.includes('empty response') ||
        msg.includes('unexpected token')
    ) {
        return 'AI_RESPONSE_ERROR';
    }
    return null;
}
