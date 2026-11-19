/** 批量操作每次请求最多携带的 id 数，与批量删除/移动接口上限一致 */
export const BATCH_ACTION_CHUNK_SIZE = 100;

export function chunkIds(ids: string[], size = BATCH_ACTION_CHUNK_SIZE): string[][] {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += size) {
        chunks.push(ids.slice(i, i + size));
    }
    return chunks;
}

export interface ChunkedBatchOutcome<R> {
    /** 已成功返回的各批结果 */
    results: R[];
    /** 已成功提交的 id */
    processedIds: string[];
    /** 失败批次及其之后未提交的 id */
    unprocessedIds: string[];
    /** 首个失败批次的错误；全部成功时为 null */
    error: unknown;
}

/**
 * 按批顺序提交；某一批失败即停止，并返回已完成与未完成的明细。
 * 分批请求不是原子操作，调用方须据此刷新界面并提示部分成功。
 */
export async function runInChunks<R>(
    ids: string[],
    run: (batch: string[]) => Promise<R>,
    size = BATCH_ACTION_CHUNK_SIZE,
): Promise<ChunkedBatchOutcome<R>> {
    const results: R[] = [];
    const processedIds: string[] = [];
    const chunks = chunkIds(ids, size);
    for (let index = 0; index < chunks.length; index++) {
        try {
            results.push(await run(chunks[index]));
            processedIds.push(...chunks[index]);
        } catch (error) {
            return { results, processedIds, unprocessedIds: chunks.slice(index).flat(), error };
        }
    }
    return { results, processedIds, unprocessedIds: [], error: null };
}
