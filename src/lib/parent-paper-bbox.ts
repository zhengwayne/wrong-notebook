/**
 * 家长试卷题框坐标变换：随页面顺时针旋转 90/180/270 度，保持与展示图同一坐标系。
 */
import { clampNormalizedBBox, type QuestionBBox } from "@/lib/parent-paper-review";

export type ClockwiseRotation = 0 | 90 | 180 | 270;

export function isClockwiseRotation(value: unknown): value is ClockwiseRotation {
    return value === 0 || value === 90 || value === 180 || value === 270;
}

/** 将归一化 bbox 随图像顺时针旋转；四次 90 度后应回到原框。 */
export function transformNormalizedBBox(bbox: QuestionBBox, clockwise: ClockwiseRotation): QuestionBBox {
    let { x, y, width, height } = bbox;
    const steps = ((clockwise % 360) + 360) % 360 / 90;
    for (let i = 0; i < steps; i += 1) {
        const nextX = 1 - y - height;
        const nextY = x;
        const nextWidth = height;
        const nextHeight = width;
        x = nextX;
        y = nextY;
        width = nextWidth;
        height = nextHeight;
    }
    return clampNormalizedBBox({
        pageIndex: bbox.pageIndex,
        x,
        y,
        width,
        height,
    }) ?? { pageIndex: bbox.pageIndex, x, y, width, height };
}
