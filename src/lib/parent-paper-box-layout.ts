/**
 * 把同一页上重叠的题框按阅读顺序剪开，避免左右栏或上下题互相覆盖。
 */
import { clampNormalizedBBox, type QuestionBBox } from "@/lib/parent-paper-review";

const GAP = 0.008;
const MIN_WIDTH = 0.04;

function overlaps(a: QuestionBBox, b: QuestionBBox): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function horizontalOverlap(a: QuestionBBox, b: QuestionBBox): number {
    return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
}

function verticalOverlap(a: QuestionBBox, b: QuestionBBox): number {
    return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

function withBox(box: QuestionBBox, patch: Partial<QuestionBBox>): QuestionBBox {
    return clampNormalizedBBox({ ...box, ...patch }) ?? box;
}

/**
 * 先处理同一行的左右重叠（剪左边框的右缘），再处理上下重叠（剪上方框的底缘）。
 * 不改后一题的位置，避免把框推离题目。
 */
export function resolveOverlappingBBoxes(boxes: QuestionBBox[]): QuestionBBox[] {
    const byPage = new Map<number, number[]>();
    const next = boxes.map((box) => ({ ...box }));
    next.forEach((box, index) => {
        const list = byPage.get(box.pageIndex) ?? [];
        list.push(index);
        byPage.set(box.pageIndex, list);
    });

    for (const indexes of byPage.values()) {
        const order = [...indexes].sort((i, j) => next[i].y - next[j].y || next[i].x - next[j].x || i - j);

        for (let a = 0; a < order.length; a++) {
            for (let b = a + 1; b < order.length; b++) {
                const i = order[a];
                const j = order[b];
                const left = next[i];
                const right = next[j];
                if (!overlaps(left, right)) continue;
                const sameRow = verticalOverlap(left, right) >= Math.min(left.height, right.height) * 0.45
                    && Math.abs((left.y + left.height / 2) - (right.y + right.height / 2)) <= Math.max(left.height, right.height) * 0.6;
                if (sameRow) {
                    const [leftIndex, rightIndex] = next[i].x <= next[j].x ? [i, j] : [j, i];
                    const prior = next[leftIndex];
                    const latter = next[rightIndex];
                    const width = latter.x - GAP - prior.x;
                    if (width >= MIN_WIDTH) next[leftIndex] = withBox(prior, { width });
                }
            }
        }

        for (let a = 0; a < order.length; a++) {
            for (let b = a + 1; b < order.length; b++) {
                const i = order[a];
                const j = order[b];
                const upper = next[i];
                const lower = next[j];
                if (!overlaps(upper, lower)) continue;
                if (lower.y >= upper.y && horizontalOverlap(upper, lower) > Math.min(upper.width, lower.width) * 0.25) {
                    const height = lower.y - GAP - upper.y;
                    if (height > 0) next[i] = withBox(upper, { height });
                }
            }
        }
    }
    return next;
}

export function layoutParentPaperBBoxes<T extends { bbox: QuestionBBox | null }>(questions: T[]): T[] {
    const boxes = questions.map((question) => question.bbox);
    const present: QuestionBBox[] = [];
    const slots: number[] = [];
    boxes.forEach((box, index) => {
        if (!box) return;
        slots.push(index);
        present.push(box);
    });
    if (present.length < 2) return questions;
    const resolved = resolveOverlappingBBoxes(present);
    return questions.map((question, index) => {
        const slot = slots.indexOf(index);
        if (slot < 0) return question;
        return { ...question, bbox: resolved[slot] };
    });
}

/** 顶角过近的题号徽章向下错开，避免叠在一起。 */
export function badgeOffsets(boxes: Array<{ id: string; bbox: QuestionBBox }>): Record<string, number> {
    const offsets: Record<string, number> = {};
    const items = [...boxes].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    for (let i = 0; i < items.length; i++) {
        let used = 0;
        for (let j = 0; j < i; j++) {
            const dx = Math.abs(items[i].bbox.x - items[j].bbox.x);
            const dy = Math.abs(items[i].bbox.y - items[j].bbox.y) + (offsets[items[j].id] || 0) * 0.012;
            if (dx < 0.08 && dy < 0.035) used = Math.max(used, (offsets[items[j].id] || 0) + 1);
        }
        if (used) offsets[items[i].id] = used;
    }
    return offsets;
}
