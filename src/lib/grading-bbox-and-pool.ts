import { cropDataUrlRegion } from "@/lib/parent-paper-crop";
import { validateQuestionBBox, type QuestionBBox } from "@/lib/parent-paper-review";

export const DEFAULT_GRADING_CONCURRENCY = 3;

/**
 * 有界并发池：替代原先的单循环串行等待，同时严格限制并发任务数避免瞬间打满内存或下游连接。
 */
export async function runBoundedConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    if (items.length === 0) return;
    const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
    let nextIndex = 0;

    const runLane = async () => {
        while (nextIndex < items.length) {
            const current = nextIndex;
            nextIndex += 1;
            await worker(items[current], current);
        }
    };

    await Promise.all(Array.from({ length: limit }, () => runLane()));
}

/** 安全解析存储在数据库中的单题归一化 bbox JSON */
export function parseStoredGradingBbox(raw: string | null | undefined, pageCount: number): QuestionBBox | null {
    if (!raw) return null;
    try {
        return validateQuestionBBox(JSON.parse(raw), Math.max(1, pageCount));
    } catch {
        return null;
    }
}

/**
 * 确认答卷导入错题本前，在数据库写事务之外按单题 bbox 从对应页裁出清晰单题图；
 * 无有效 bbox 或裁切异常时自动回退至首页整图，绝不阻塞入库。
 */
export async function resolveCroppedGradingItemImage(
    pages: readonly string[],
    rawBbox: string | null | undefined,
): Promise<string> {
    const fallback = pages[0] || "";
    if (pages.length === 0) return "";
    const bbox = parseStoredGradingBbox(rawBbox, pages.length);
    if (!bbox) return fallback;
    const targetPage = pages[bbox.pageIndex] || fallback;
    if (!targetPage) return fallback;
    const { imageUrl } = await cropDataUrlRegion(targetPage, {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
    });
    return imageUrl || fallback;
}
