/**
 * AI 调用总时限（思路参考 margrop/wrong-notebook 77e8c8cb, MIT）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import {
    AI_CALL_DEADLINE_MS,
    VERCEL_AI_CALL_DEADLINE_MS,
    aiCallDeadlineMs,
    currentAiDeadlineSignal,
    deadlineFetch,
    isAiDeadlineExceeded,
    runWithAiDeadline,
    withAiCallDeadline,
} from '@/lib/ai/deadline';

describe('AI 调用总时限', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('默认 10 分钟，Vercel 上 280 秒（早于函数被强制结束）', () => {
        vi.stubEnv('VERCEL', '');
        expect(aiCallDeadlineMs()).toBe(AI_CALL_DEADLINE_MS);
        vi.stubEnv('VERCEL', '1');
        expect(aiCallDeadlineMs()).toBe(VERCEL_AI_CALL_DEADLINE_MS);
        expect(VERCEL_AI_CALL_DEADLINE_MS).toBeLessThan(300_000);
    });

    it('服务商一直不响应时按 AI_TIMEOUT_ERROR 结束，并中止底层请求', async () => {
        let seenSignal: AbortSignal | undefined;
        const service = withAiCallDeadline({
            analyze: () => new Promise<string>(() => { seenSignal = currentAiDeadlineSignal(); }),
        }, 1000);
        const result = service.analyze().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1000);
        expect(((await result) as Error).message).toBe('AI_TIMEOUT_ERROR');
        expect(seenSignal?.aborted).toBe(true);
    });

    it('按时完成的调用正常返回，且不留下计时器', async () => {
        const service = withAiCallDeadline({ value: 1, add: async (a: number, b: number) => a + b }, 1000);
        await expect(service.add(1, 2)).resolves.toBe(3);
        expect(service.value).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(currentAiDeadlineSignal()).toBeUndefined();
    });

    it('同步抛出的错误原样传出', async () => {
        const service = withAiCallDeadline({ boom: () => { throw new Error('AI_AUTH_ERROR'); } }, 1000);
        await expect(service.boom()).rejects.toThrow('AI_AUTH_ERROR');
    });

    it('嵌套调用沿用最外层时限', async () => {
        const inner = vi.fn(async () => isAiDeadlineExceeded());
        const outer = runWithAiDeadline(() => runWithAiDeadline(inner, 10), 1000);
        await expect(outer).resolves.toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('deadlineFetch 把总时限信号合并到请求里', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return new Response(String(init?.signal?.aborted));
        });
        vi.stubGlobal('fetch', fetchMock);
        const callerSignal = new AbortController().signal;
        const pending = runWithAiDeadline(() => deadlineFetch('https://example.com', { signal: callerSignal }), 1000).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1000);
        expect(((await pending) as Error).message).toBe('AI_TIMEOUT_ERROR');
        const passed = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
        expect(passed.aborted).toBe(true);
        expect(passed).not.toBe(callerSignal);
    });

    it('不在 AI 调用内时 deadlineFetch 原样转发', async () => {
        const fetchMock = vi.fn(async () => new Response('ok'));
        vi.stubGlobal('fetch', fetchMock);
        const init = { method: 'POST' };
        await deadlineFetch('https://example.com', init);
        expect(fetchMock).toHaveBeenCalledWith('https://example.com', init);
    });
});
