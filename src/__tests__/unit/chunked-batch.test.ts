import { describe, expect, it, vi } from 'vitest';
import { BATCH_ACTION_CHUNK_SIZE, chunkIds, runInChunks } from '@/lib/chunked-batch';

describe('分批提交', () => {
    it('按上限切分 id', () => {
        const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
        expect(chunkIds(ids).map((chunk) => chunk.length)).toEqual([BATCH_ACTION_CHUNK_SIZE, BATCH_ACTION_CHUNK_SIZE, 50]);
        expect(chunkIds([])).toEqual([]);
    });

    it('全部成功时返回各批结果，无未处理 id', async () => {
        const run = vi.fn(async (batch: string[]) => batch.length);
        const outcome = await runInChunks(['a', 'b', 'c'], run, 2);
        expect(outcome).toEqual({ results: [2, 1], processedIds: ['a', 'b', 'c'], unprocessedIds: [], error: null });
    });

    it('某批失败即停止，返回已完成与未完成明细', async () => {
        const failure = new Error('boom');
        const run = vi.fn()
            .mockResolvedValueOnce('ok')
            .mockRejectedValueOnce(failure);
        const outcome = await runInChunks(['a', 'b', 'c', 'd', 'e'], run, 2);
        expect(run).toHaveBeenCalledTimes(2);
        expect(outcome.results).toEqual(['ok']);
        expect(outcome.processedIds).toEqual(['a', 'b']);
        expect(outcome.unprocessedIds).toEqual(['c', 'd', 'e']);
        expect(outcome.error).toBe(failure);
    });
});
