/**
 * 单次 AI 调用的总时限：从拿到并发名额开始计时，包含 SDK 内部重试在内，到期即中止底层请求
 * 并以 AI_TIMEOUT_ERROR 结束，避免服务商不响应时请求一直挂着、占住并发名额。
 * 所有渠道（OpenAI 及兼容接口、Azure、Anthropic、Gemini、MiniMax Code）统一生效。
 *
 * 思路参考 margrop/wrong-notebook 77e8c8cb（MIT）的 AI 调用总时限，按本项目的 Provider 结构重写。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../logger';

const logger = createLogger('ai:deadline');

/** 单次 AI 调用总时限（与 Anthropic 单次请求超时一致，保守取 10 分钟） */
export const AI_CALL_DEADLINE_MS = 10 * 60 * 1000;

/** Vercel 函数最长运行 300 秒，须在函数被强制结束前超时，才能返回明确的超时错误 */
export const VERCEL_AI_CALL_DEADLINE_MS = 280 * 1000;

/** 当前部署环境下单次 AI 调用的总时限 */
export function aiCallDeadlineMs(): number {
    return process.env.VERCEL ? VERCEL_AI_CALL_DEADLINE_MS : AI_CALL_DEADLINE_MS;
}

const deadlineStorage = new AsyncLocalStorage<AbortSignal>();

/** 当前 AI 调用的总时限信号；不在 AI 调用内时为 undefined */
export function currentAiDeadlineSignal(): AbortSignal | undefined {
    return deadlineStorage.getStore();
}

/** 总时限是否已到（Gemini 重试循环据此停止重试） */
export function isAiDeadlineExceeded(): boolean {
    return deadlineStorage.getStore()?.aborted === true;
}

/**
 * 在总时限内执行一次 AI 调用。嵌套调用沿用最外层的时限，不重新计时。
 */
export async function runWithAiDeadline<T>(operation: () => Promise<T>, deadlineMs = aiCallDeadlineMs(), label = 'ai'): Promise<T> {
    if (deadlineStorage.getStore()) return operation();

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error('AI_TIMEOUT_ERROR');
            logger.warn({ method: label, deadlineMs }, 'AI request exceeded total deadline');
            controller.abort(error);
            reject(error);
        }, deadlineMs);
    });

    try {
        return await Promise.race([deadlineStorage.run(controller.signal, operation), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** 给 AI 服务的每个方法加上总时限（放在并发限制之内，排队时间不计入） */
export function withAiCallDeadline<T extends object>(service: T, deadlineMs?: number): T {
    return new Proxy(service, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function' || prop === 'constructor') return value;
            return (...args: unknown[]) => runWithAiDeadline(
                () => Promise.resolve(value.apply(target, args)),
                deadlineMs ?? aiCallDeadlineMs(),
                String(prop),
            );
        },
    });
}

/** 合并调用方信号与总时限信号 */
export function withDeadlineSignal(signal?: AbortSignal | null): AbortSignal | undefined {
    const deadline = deadlineStorage.getStore();
    if (!deadline) return signal ?? undefined;
    if (!signal) return deadline;
    return AbortSignal.any([signal, deadline]);
}

/**
 * 交给 OpenAI / Azure / Anthropic SDK 的 fetch：到达总时限时中止正在进行的请求（SDK 不会对主动中止重试）。
 */
export const deadlineFetch: typeof fetch = (input, init) => {
    const signal = withDeadlineSignal(init?.signal);
    return fetch(input, signal ? { ...init, signal } : init);
};
