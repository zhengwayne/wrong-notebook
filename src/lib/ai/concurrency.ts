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

interface ConcurrencyTelemetry {
    totalCalls: number;
    succeededCalls: number;
    provider429Count: number;
    queueRejectedCount: number;
    waitSamplesMs: number[];
}

export interface ModelQueueState {
    provider: string;
    model: string;
    active: number;
    waiting: number;
}

export interface AiConcurrencyTelemetrySnapshot {
    totalCalls: number;
    succeededCalls: number;
    provider429Count: number;
    provider429Rate: number;
    queueRejectedCount: number;
    queueSaturationRate: number;
    waitSampleCount: number;
    waitMs: {
        p50: number;
        p95: number;
        p99: number;
        max: number;
    };
    limit: number;
    maxWaiting: number;
    queues: ModelQueueState[];
}

const MAX_WAIT_SAMPLES = 1000;

const store = globalThis as typeof globalThis & {
    __aiModelConcurrencyQueues?: Map<string, ModelQueue>;
    __aiConcurrencyTelemetry?: ConcurrencyTelemetry;
};
const queues: Map<string, ModelQueue> = store.__aiModelConcurrencyQueues ??= new Map();
const telemetry: ConcurrencyTelemetry = store.__aiConcurrencyTelemetry ??= {
    totalCalls: 0,
    succeededCalls: 0,
    provider429Count: 0,
    queueRejectedCount: 0,
    waitSamplesMs: [],
};

function recordWaitSample(waitMs: number): void {
    const normalized = Math.max(0, Math.round(waitMs));
    if (telemetry.waitSamplesMs.length >= MAX_WAIT_SAMPLES) {
        telemetry.waitSamplesMs.shift();
    }
    telemetry.waitSamplesMs.push(normalized);
}

function isProvider429Error(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 3 && current; depth += 1) {
        if (current instanceof Error && (current.message === "AI_QUOTA_EXCEEDED" || current.message.startsWith("AI_QUOTA_EXCEEDED:"))) {
            return true;
        }
        if (typeof current === "object" && current !== null) {
            const record = current as { status?: unknown; statusCode?: unknown; cause?: unknown };
            if (record.status === 429 || record.statusCode === 429) {
                return true;
            }
            current = record.cause;
        } else {
            break;
        }
    }
    return false;
}

function roundRatio(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function pickPercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

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

function formatSafeModelKey(key: string): string {
    if (!key.includes("|")) return key;
    const parts = key.split("|");
    const provider = parts[0] || "unknown";
    const model = parts.length >= 3 ? parts.slice(2).join("|") : "";
    return model ? `${provider}|${model}` : provider;
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
        logger.warn({ model: formatSafeModelKey(key), active: queue.active, waiting: queue.waiting.length, maxWaiting }, "AI queue is full");
        cleanupQueueIfIdle(key, queue);
        return Promise.reject(
            new AiConcurrencyError("QUEUE_FULL", 429, Math.max(1, Math.ceil(retryAfterSeconds / 2))),
        );
    }

    logger.info({ model: formatSafeModelKey(key), active: queue.active, waiting: queue.waiting.length + 1 }, "AI call queued by concurrency limit");
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
            logger.warn({ model: formatSafeModelKey(key), active: current.active, waiting: current.waiting.length, queueTimeoutMs }, "AI queue wait timed out");
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
    telemetry.totalCalls += 1;
    const waitStartedAt = Date.now();
    try {
        await acquire(key, options);
    } catch (error) {
        if (error instanceof AiConcurrencyError && (error.reason === "QUEUE_FULL" || error.reason === "QUEUE_TIMEOUT")) {
            telemetry.queueRejectedCount += 1;
        }
        throw error;
    }
    recordWaitSample(Date.now() - waitStartedAt);

    try {
        const result = await task();
        telemetry.succeededCalls += 1;
        return result;
    } catch (error) {
        if (isProvider429Error(error)) {
            telemetry.provider429Count += 1;
        }
        throw error;
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

/** 列出当前所有活跃或排队队列的脱敏状态（不暴露 baseUrl 等配置地址） */
export function getAllModelConcurrencyStates(): ModelQueueState[] {
    const result: ModelQueueState[] = [];
    for (const [key, queue] of queues.entries()) {
        const parts = key.split("|");
        const provider = parts[0] || key;
        const model = parts.length >= 3 ? parts.slice(2).join("|") : "";
        result.push({
            provider,
            model,
            active: queue.active,
            waiting: queue.waiting.length,
        });
    }
    return result;
}

/** 返回 AI 并发队列、429 限流与排队耗时遥测快照 */
export function getAiConcurrencyTelemetry(): AiConcurrencyTelemetrySnapshot {
    const limit = getLimit();
    const maxWaiting = getMaxWaiting(limit);
    const sorted = [...telemetry.waitSamplesMs].sort((a, b) => a - b);
    const total = telemetry.totalCalls;
    return {
        totalCalls: total,
        succeededCalls: telemetry.succeededCalls,
        provider429Count: telemetry.provider429Count,
        provider429Rate: total > 0 ? roundRatio(telemetry.provider429Count / total) : 0,
        queueRejectedCount: telemetry.queueRejectedCount,
        queueSaturationRate: total > 0 ? roundRatio(telemetry.queueRejectedCount / total) : 0,
        waitSampleCount: sorted.length,
        waitMs: {
            p50: pickPercentile(sorted, 0.5),
            p95: pickPercentile(sorted, 0.95),
            p99: pickPercentile(sorted, 0.99),
            max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        },
        limit,
        maxWaiting,
        queues: getAllModelConcurrencyStates(),
    };
}

/** 重置内存并发遥测计数器（仅用于测试） */
export function resetConcurrencyTelemetryForTest(): void {
    telemetry.totalCalls = 0;
    telemetry.succeededCalls = 0;
    telemetry.provider429Count = 0;
    telemetry.queueRejectedCount = 0;
    telemetry.waitSamplesMs.length = 0;
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
