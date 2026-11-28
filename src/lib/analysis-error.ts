import { classifyAiErrorText } from "@/lib/ai/error-text-classification";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import type { Translations } from "@/lib/translations";

/**
 * 题目识别失败时显示的提示：后端返回已知错误码时用对应文案，服务商原文先归类再翻译，
 * 网络错误提示连接失败，响应体为文本（如 HTML 错误页）时附上状态码。
 */
export function getAnalysisErrorMessage(error: unknown, t: Translations): string {
    const fallback = t.common?.messages?.analysisFailed || 'Analysis failed, please try again';

    const backendMessage = getApiErrorMessage(error);
    if (backendMessage) {
        const errors: Record<string, unknown> = t.errors ?? {};
        const head = backendMessage.split(':')[0]?.trim() || backendMessage;
        if (backendMessage in errors) {
            const mapped = errors[backendMessage];
            return typeof mapped === 'string' ? mapped : fallback;
        }
        if (head in errors) {
            const mapped = errors[head];
            return typeof mapped === 'string' ? mapped : fallback;
        }
        const classified = classifyAiErrorText(backendMessage);
        if (classified && typeof errors[classified] === 'string') {
            return errors[classified] as string;
        }
        return backendMessage;
    }

    const message = getErrorMessage(error);
    if (message === 'HEIC_UNSUPPORTED' || (error instanceof Error && error.name === 'HEIC_UNSUPPORTED')) {
        return t.errors?.HEIC_UNSUPPORTED || message;
    }
    if (message.includes('fetch') || message.includes('network')) {
        return t.errors?.AI_CONNECTION_FAILED || '网络连接失败';
    }
    if (typeof error === 'object' && error !== null && 'data' in error && typeof error.data === 'string') {
        const status = 'status' in error && typeof error.status === 'number' ? error.status : 'Error';
        return `${fallback} (${status})`;
    }
    return fallback;
}
