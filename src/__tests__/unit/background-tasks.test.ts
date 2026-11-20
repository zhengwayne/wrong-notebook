import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearFinishedBackgroundTasks,
    describeQuestion,
    FINISHED_TASK_TTL_MS,
    listBackgroundTasks,
    resetBackgroundTasksForTest,
    startBackgroundTask,
    trackBackgroundTask,
} from '@/lib/background-tasks';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

beforeEach(() => resetBackgroundTasksForTest());
afterEach(() => vi.useRealTimers());

describe('后台事务登记', () => {
    it('trackBackgroundTask 运行时为进行中，完成后为成功，返回结果', async () => {
        let resolve!: (value: string) => void;
        const running = trackBackgroundTask({ userId: 'u1', kind: 'svg_animation', subject: 'hA6PB9 求面积', link: '/error-items/e1' }, () => new Promise<string>((r) => { resolve = r; }));

        expect(listBackgroundTasks('u1')).toMatchObject([{ kind: 'svg_animation', status: 'running', subject: 'hA6PB9 求面积', link: '/error-items/e1', finishedAt: null }]);
        resolve('svg');
        expect(await running).toBe('svg');
        expect(listBackgroundTasks('u1')[0]).toMatchObject({ status: 'succeeded', error: null });
        expect(listBackgroundTasks('u1')[0].finishedAt).not.toBeNull();
    });

    it('失败时记录错误码并继续抛出', async () => {
        await expect(trackBackgroundTask({ userId: 'u1', kind: 'reanswer' }, async () => { throw new Error('AI_RESPONSE_ERROR: 格式不对'); })).rejects.toThrow('AI_RESPONSE_ERROR');
        expect(listBackgroundTasks('u1')[0]).toMatchObject({ status: 'failed', error: 'AI_RESPONSE_ERROR' });
    });

    it('批量事务记录进度，结束后状态不再改变', () => {
        const task = startBackgroundTask({ userId: 'u1', kind: 'retag_notebook', total: 3 });
        expect(listBackgroundTasks('u1')[0].progress).toEqual({ done: 0, total: 3, failed: 0 });
        task.setProgress(2, 3, 1);
        expect(listBackgroundTasks('u1')[0].progress).toEqual({ done: 2, total: 3, failed: 1 });
        task.succeed();
        task.fail(new Error('late'));
        expect(listBackgroundTasks('u1')[0]).toMatchObject({ status: 'succeeded', error: null });
    });

    it('只返回本人的事务：进行中的在前，不暴露用户 ID', () => {
        startBackgroundTask({ userId: 'u2', kind: 'analyze' });
        const done = startBackgroundTask({ userId: 'u1', kind: 'figure' });
        done.succeed();
        startBackgroundTask({ userId: 'u1', kind: 'exam', total: 5 });

        const list = listBackgroundTasks('u1');
        expect(list.map((task) => task.kind)).toEqual(['exam', 'figure']);
        expect(list[0]).not.toHaveProperty('userId');
    });

    it('已结束的事务 30 分钟后清理，也可手动清除，进行中的保留', () => {
        vi.useFakeTimers();
        startBackgroundTask({ userId: 'u1', kind: 'analyze' }).succeed();
        startBackgroundTask({ userId: 'u1', kind: 'svg_animation' });
        vi.advanceTimersByTime(FINISHED_TASK_TTL_MS + 1000);
        expect(listBackgroundTasks('u1').map((task) => task.kind)).toEqual(['svg_animation']);

        startBackgroundTask({ userId: 'u1', kind: 'figure' }).fail(new Error('x'));
        clearFinishedBackgroundTasks('u1');
        expect(listBackgroundTasks('u1').map((task) => task.status)).toEqual(['running']);
    });

    it('题目说明为编号加去掉公式符号的题干开头', () => {
        expect(describeQuestion({ shortId: 'hA6PB9', questionText: '已知 $\\frac{1}{2}x = 3$，\n求 **x** 的值，并说明理由，写出完整的过程和步骤' }))
            .toBe('hA6PB9 已知 1 2 x = 3，求 x 的值，并说明理…');
        expect(describeQuestion({ questionText: '' })).toBe('—');
    });

    it('超过保留时长的已结束事务会在下一次读写时被自动清理，进行中事务保留', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
        startBackgroundTask({ userId: 'u1', kind: 'reanswer', subject: '待过期任务' }).succeed();
        startBackgroundTask({ userId: 'u1', kind: 'analyze', subject: '仍在运行' });

        vi.advanceTimersByTime(FINISHED_TASK_TTL_MS + 1000);
        const list = listBackgroundTasks('u1');
        expect(list.map((t) => t.subject)).toEqual(['仍在运行']);
    });
});
