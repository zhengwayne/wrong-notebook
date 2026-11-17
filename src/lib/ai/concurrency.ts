/**
 * AI 模型调用并发限制：同一模型（同一渠道、地址和模型名）同时进行的调用不超过上限，
 * 超出的调用在有界队列内先来后到排队，避免触发服务商 429 限流与内存无限积压。
 */
import type { NextResponse } from "next/server";
import { parseConcurrencyLimit } from "../ai-concurrency-limit";
import { createErrorResponse, ErrorCode, serviceUnavailable, type ApiErrorResponse } from "../api-errors";
import { getAppConfig } from "../config";
import { createLogger } from "../logger";

const logger = createLogger("ai:concurrency");

export const DEFAULT_AI_QUEUE_TIMEOUT_MS = 30_000;

interface QueueWaiter {
    wake: () => void;
    cancel: (error: Error) => void;
    settled: boolean;
}

interface ModelQueue {
    active: number;
    waiting: QueueWaiter[];
}

export type AiConcurrencyErrorReason = "QUEUE_FULL" | "QUEUE_TIMEOUT" | "ABORTED";

export class AiConcurrencyError extends Error {
    readonly reason: AiConcurrencyErrorReason;
    readonly status: 429 | 503;
    readonly retryAfterSeconds: number;

    constructor(
        reason: AiConcurrencyErrorReason,
        status: 429 | 503,
        retryAfterSeconds: number,
        message?: string,
    ) {
        super(message || (reason === "QUEUE_FULL" ? "AI_QUEUE_FULL" : reason === "QUEUE_TIMEOUT" ? "AI_QUEUE_TIMEOUT" : "AI_REQUEST_ABORTED"));
        this.name = "AiConcurrencyError";
        this.reason = reason;
        this.status = status;
        this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    }
}

export interface ConcurrencyRunOptions {
    maxWaiting?: number;
    queueTimeoutMs?: number;
    signal?: AbortSignal;
}

const store = globalThis as typeof globalThis & {
    __aiModelConcurrencyQueues?: Map<string, ModelQueue>;
};
const queues: Map<string, ModelQueue> = store.__aiModelConcurrencyQueues ??= new Map();

function readConfigSafe() {
    try {
        return getAppConfig();
    } catch {
        return null;
    }
}

function getLimit(): number {
    return parseConcurrencyLimit(readConfigSafe()?.aiConcurrencyLimit);
}

function getMaxWaiting(limit: number, override?: number): number {
    if (typeof override === "number" && Number.isInteger(override) && override >= 0) {
        return override;
    }
    const configured = readConfigSafe()?.aiQueueMaxWaiting;
    if (typeof configured === "number" && Number.isInteger(configured) && configured >= 0) {
        return configured;
    }
    return Math.max(20, limit * 8);
}

function getQueueTimeoutMs(override?: number): number {
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
        return override;
    }
    const configured = readConfigSafe()?.aiQueueTimeoutMs;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
        return configured;
    }
    return DEFAULT_AI_QUEUE_TIMEOUT_MS;
}

function cleanupQueueIfIdle(key: string, queue: ModelQueue): void {
    if (queue.active === 0 && queue.waiting.length === 0) {
        queues.delete(key);
    }
}

/** 在空位允许时依次放行排队的调用 */
function dispatch(key: string, queue: ModelQueue): void {
    const limit = getLimit();
    while (queue.active < limit && queue.waiting.length > 0) {
        const next = queue.waiting.shift();
        if (!next || next.settled) continue;
        queue.active += 1;
        next.wake();
    }
    cleanupQueueIfIdle(key, queue);
}

/** 取得一个调用名额，超出上限时进入有界、带超时与取消感知的排队队列 */
function acquire(key: string, options?: ConcurrencyRunOptions): Promise<void> {
    if (options?.signal?.aborted) {
        return Promise.reject(new AiConcurrencyError("ABORTED", 503, 1));
    }

    let queue = queues.get(key);
    if (!queue) {
        queue = { active: 0, waiting: [] };
        queues.set(key, queue);
    }

    const limit = getLimit();
    if (queue.active < limit && queue.waiting.length === 0) {
        queue.active += 1;
        return Promise.resolve();
    }

    const maxWaiting = getMaxWaiting(limit, options?.maxWaiting);
    const queueTimeoutMs = getQueueTimeoutMs(options?.queueTimeoutMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(queueTimeoutMs / 1000));

    if (queue.waiting.length >= maxWaiting) {
        logger.warn({ model: key, active: queue.active, waiting: queue.waiting.length, maxWaiting }, "AI queue is full");
        cleanupQueueIfIdle(key, queue);
        return Promise.reject(
            new AiConcurrencyError("QUEUE_FULL", 429, Math.max(1, Math.ceil(retryAfterSeconds / 2))),
        );
    }

    logger.info({ model: key, active: queue.active, waiting: queue.waiting.length + 1 }, "AI call queued by concurrency limit");
    const current = queue;

    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;

        const detachFromQueue = () => {
            const idx = current.waiting.indexOf(waiter);
            if (idx !== -1) {
                current.waiting.splice(idx, 1);
            }
            cleanupQueueIfIdle(key, current);
        };

        const cleanupListeners = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            options?.signal?.removeEventListener("abort", onAbort);
        };

        const waiter: QueueWaiter = {
            settled: false,
            wake: () => {
                if (waiter.settled) return;
                waiter.settled = true;
                cleanupListeners();
                resolve();
            },
            cancel: (error: Error) => {
                if (waiter.settled) return;
                waiter.settled = true;
                cleanupListeners();
                detachFromQueue();
                reject(error);
            },
        };

        const onAbort = () => {
            waiter.cancel(new AiConcurrencyError("ABORTED", 503, 1));
        };

        if (options?.signal) {
            options.signal.addEventListener("abort", onAbort, { once: true });
        }

        timer = setTimeout(() => {
            logger.warn({ model: key, active: current.active, waiting: current.waiting.length, queueTimeoutMs }, "AI queue wait timed out");
            waiter.cancel(new AiConcurrencyError("QUEUE_TIMEOUT", 503, retryAfterSeconds));
        }, queueTimeoutMs);
        timer.unref?.();

        current.waiting.push(waiter);
    });
}

function release(key: string): void {
    const queue = queues.get(key);
    if (!queue) return;
    queue.active = Math.max(0, queue.active - 1);
    dispatch(key, queue);
}

/** 在模型的并发上限内执行一次 AI 调用（支持队列上限、等待超时与取消信号） */
export async function runWithModelConcurrency<T>(
    key: string,
    task: () => Promise<T>,
    options?: ConcurrencyRunOptions,
): Promise<T> {
    await acquire(key, options);
    try {
        return await task();
    } finally {
        release(key);
    }
}

/** 将并发队列饱和/超时异常映射为标准 HTTP 429/503 + Retry-After 响应 */
export function toConcurrencyErrorResponse(error: unknown): NextResponse<ApiErrorResponse> | null {
    if (!(error instanceof AiConcurrencyError)) return null;
    if (error.reason === "QUEUE_FULL") {
        const res = createErrorResponse("AI service is busy, please retry later", 429, ErrorCode.AI_QUEUE_BUSY);
        res.headers.set("Retry-After", String(error.retryAfterSeconds));
        return res;
    }
    const message = error.reason === "QUEUE_TIMEOUT" ? "AI queue wait timed out" : "AI request aborted";
    return serviceUnavailable(error.retryAfterSeconds, message, ErrorCode.AI_QUEUE_BUSY);
}

/** 当前各模型的进行中和排队数量（用于日志与测试） */
export function getModelConcurrencyState(key: string): { active: number; waiting: number } {
    const queue = queues.get(key);
    return { active: queue?.active ?? 0, waiting: queue?.waiting.length ?? 0 };
}

/**
 * 包装 AI 服务：每个方法调用都受同一模型的并发上限约束。
 * 方法内部通过 this 调用的其他方法不再重复排队，避免互相等待。
 */
export function limitModelConcurrency<T extends object>(service: T, key: string): T {
    return new Proxy(service, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function" || prop === "constructor") return value;
            return (...args: unknown[]) => runWithModelConcurrency(key, () => Promise.resolve(value.apply(target, args)));
        },
    });
}
