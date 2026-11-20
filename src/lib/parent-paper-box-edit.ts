import { clampNormalizedBBox, type QuestionBBox } from "@/lib/parent-paper-review";
import { regionFromPoints, type ImageRegion } from "@/lib/image-crop";

export type BoxHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN = 0.02;

/** 按拖拽手柄移动或缩放归一化矩形，并夹紧在页面内 */
export function resizeNormalizedBox(
    start: ImageRegion,
    from: { x: number; y: number },
    to: { x: number; y: number },
    handle: BoxHandle,
): ImageRegion {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let x1 = start.x;
    let y1 = start.y;
    let x2 = start.x + start.width;
    let y2 = start.y + start.height;

    if (handle === "move") {
        const width = start.width;
        const height = start.height;
        const nextX = Math.min(1 - width, Math.max(0, start.x + dx));
        const nextY = Math.min(1 - height, Math.max(0, start.y + dy));
        return { x: nextX, y: nextY, width, height };
    }
    if (handle.includes("w")) x1 += dx;
    if (handle.includes("e")) x2 += dx;
    if (handle.includes("n")) y1 += dy;
    if (handle.includes("s")) y2 += dy;

    const region = regionFromPoints(x1, y1, x2, y2);
    if (region.width < MIN) {
        if (handle.includes("w")) region.x = start.x + start.width - MIN;
        region.width = MIN;
    }
    if (region.height < MIN) {
        if (handle.includes("n")) region.y = start.y + start.height - MIN;
        region.height = MIN;
    }
    return {
        x: Math.min(1 - MIN, Math.max(0, region.x)),
        y: Math.min(1 - MIN, Math.max(0, region.y)),
        width: Math.min(1 - Math.min(1 - MIN, Math.max(0, region.x)), Math.max(MIN, region.width)),
        height: Math.min(1 - Math.min(1 - MIN, Math.max(0, region.y)), Math.max(MIN, region.height)),
    };
}

export function regionToBBox(region: ImageRegion, pageIndex: number): QuestionBBox | null {
    return clampNormalizedBBox({ pageIndex, ...region });
}
