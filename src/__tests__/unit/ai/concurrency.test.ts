/**
 * 同一模型 AI 调用并发限制单元测试
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ config: { aiConcurrencyLimit: 2 } as { aiConcurrencyLimit?: number } }));
vi.mock('@/lib/config', () => ({ getAppConfig: () => mocks.config }));

import {
    AiConcurrencyError,
    getModelConcurrencyState,
    limitModelConcurrency,
    runWithModelConcurrency,
    toConcurrencyErrorResponse,
} from '@/lib/ai/concurrency';

/** 返回一个可手动完成的任务 */
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('runWithModelConcurrency', () => {
    beforeEach(() => {
        mocks.config = { aiConcurrencyLimit: 2 };
    });

    it('超过上限的调用排队，名额释放后按顺序执行', async () => {
        const tasks = [deferred(), deferred(), deferred()];
        const started: number[] = [];
        const runs = tasks.map((task, index) => runWithModelConcurrency('m1', async () => {
            started.push(index);
            await task.promise;
            return index;
        }));

        await flush();
        expect(started).toEqual([0, 1]);
        expect(getModelConcurrencyState('m1')).toEqual({ active: 2, waiting: 1 });

        tasks[0].resolve();
        await flush();
        expect(started).toEqual([0, 1, 2]);

        tasks[1].resolve();
        tasks[2].resolve();
        expect(await Promise.all(runs)).toEqual([0, 1, 2]);
        expect(getModelConcurrencyState('m1')).toEqual({ active: 0, waiting: 0 });
    });

    it('不同模型各自计数', async () => {
        const block = deferred();
        const a = [runWithModelConcurrency('a', () => block.promise), runWithModelConcurrency('a', () => block.promise)];
        const started = vi.fn();
        const b = runWithModelConcurrency('b', async () => started());

        await b;
        expect(started).toHaveBeenCalled();
        block.resolve();
        await Promise.all(a);
    });

    it('调用失败也会释放名额', async () => {
        mocks.config = { aiConcurrencyLimit: 1 };
        await expect(runWithModelConcurrency('err', async () => { throw new Error('429'); })).rejects.toThrow('429');
        expect(await runWithModelConcurrency('err', async () => 'ok')).toBe('ok');
    });

    it('调高上限后排队的调用随下一次释放一并放行', async () => {
        mocks.config = { aiConcurrencyLimit: 1 };
        const tasks = [deferred(), deferred(), deferred()];
        const started: number[] = [];
        const runs = tasks.map((task, index) => runWithModelConcurrency('raise', async () => {
            started.push(index);
            await task.promise;
        }));
        await flush();
        expect(started).toEqual([0]);

        mocks.config = { aiConcurrencyLimit: 3 };
        tasks[0].resolve();
        await flush();
        expect(started).toEqual([0, 1, 2]);
        tasks[1].resolve();
        tasks[2].resolve();
        await Promise.all(runs);
    });

    it('配置无效时使用默认上限 5', async () => {
        mocks.config = { aiConcurrencyLimit: 0 };
        const block = deferred();
        const started: number[] = [];
        const runs = Array.from({ length: 6 }, (_, index) => runWithModelConcurrency('default', async () => {
            started.push(index);
            await block.promise;
        }));
        await flush();
        expect(started).toHaveLength(5);
        block.resolve();
        await Promise.all(runs);
    });

    it('排队超出 maxWaiting 上限时立刻拒绝并生成 429 Retry-After 响应', async () => {
        mocks.config = { aiConcurrencyLimit: 1 };
        const block = deferred();
        const active = runWithModelConcurrency('cap', () => block.promise);
        const queued = runWithModelConcurrency('cap', () => Promise.resolve('q1'), { maxWaiting: 1, queueTimeoutMs: 6000 });
        await flush();

        expect(getModelConcurrencyState('cap')).toEqual({ active: 1, waiting: 1 });

        let rejected: unknown;
        try {
            await runWithModelConcurrency('cap', () => Promise.resolve('overflow'), { maxWaiting: 1, queueTimeoutMs: 6000 });
        } catch (error) {
            rejected = error;
        }
        expect(rejected).toBeInstanceOf(AiConcurrencyError);
        expect((rejected as AiConcurrencyError).reason).toBe('QUEUE_FULL');

        const httpRes = toConcurrencyErrorResponse(rejected);
        expect(httpRes?.status).toBe(429);
        expect(httpRes?.headers.get('Retry-After')).toBe('3');

        block.resolve();
        await expect(active).resolves.toBeUndefined();
        await expect(queued).resolves.toBe('q1');
    });

    it('排队超时会摘除等待者，并返回 503 与 Retry-After', async () => {
        mocks.config = { aiConcurrencyLimit: 1 };
        const block = deferred();
        const active = runWithModelConcurrency('timeout-key', () => block.promise);
        await flush();

        const waitedTask = vi.fn(async () => 'should-not-run');
        let timeoutErr: unknown;
        try {
            await runWithModelConcurrency('timeout-key', waitedTask, { maxWaiting: 5, queueTimeoutMs: 25 });
        } catch (error) {
            timeoutErr = error;
        }

        expect(timeoutErr).toBeInstanceOf(AiConcurrencyError);
        expect((timeoutErr as AiConcurrencyError).reason).toBe('QUEUE_TIMEOUT');
        expect(getModelConcurrencyState('timeout-key')).toEqual({ active: 1, waiting: 0 });

        const httpRes = toConcurrencyErrorResponse(timeoutErr);
        expect(httpRes?.status).toBe(503);
        expect(httpRes?.headers.get('Retry-After')).toBe('1');

        block.resolve();
        await active;
        expect(waitedTask).not.toHaveBeenCalled();
    });

    it('传入 AbortSignal 取消后立即离开队列且不影响后续正常请求', async () => {
        mocks.config = { aiConcurrencyLimit: 1 };
        const block = deferred();
        const active = runWithModelConcurrency('abort-key', () => block.promise);
        await flush();

        const controller = new AbortController();
        const abortedFn = vi.fn(async () => 'never');
        const pendingAbort = runWithModelConcurrency('abort-key', abortedFn, {
            maxWaiting: 5,
            queueTimeoutMs: 5000,
            signal: controller.signal,
        });
        await flush();
        expect(getModelConcurrencyState('abort-key')).toEqual({ active: 1, waiting: 1 });

        controller.abort();
        await expect(pendingAbort).rejects.toMatchObject({ reason: 'ABORTED' });
        expect(getModelConcurrencyState('abort-key')).toEqual({ active: 1, waiting: 0 });

        const followUp = runWithModelConcurrency('abort-key', async () => 'after-abort');
        block.resolve();
        await active;
        await expect(followUp).resolves.toBe('after-abort');
        expect(abortedFn).not.toHaveBeenCalled();
    });
});

describe('limitModelConcurrency', () => {
    it('包装后的方法受并发限制，内部互相调用不重复排队', async () => {
        mocks.config = { aiConcurrencyLimit: 1 };
        const service = {
            async outer() { return this.inner(); },
            async inner() { return 'done'; },
        };
        const limited = limitModelConcurrency(service, 'svc');

        expect(await limited.outer()).toBe('done');
        expect(getModelConcurrencyState('svc')).toEqual({ active: 0, waiting: 0 });
    });
});
