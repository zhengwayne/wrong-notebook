/**
 * 试卷内容朝向检测：在 EXIF 已转正之后，判断画面是否仍侧着/倒置（用户横拍竖纸等）。
 * 用墨迹投影方差区分横排文字与竖向文字，再用「上半页留白更多」选择 90° 还是 270°。
 */
import type { ClockwiseRotation } from "@/lib/parent-paper-bbox";

export interface GrayImage {
    pixels: Uint8Array;
    width: number;
    height: number;
}

export interface InkProjectionScores {
    rowVar: number;
    colVar: number;
    rowOverCol: number;
    topInkRatio: number;
    botInkRatio: number;
    inkRatio: number;
}

const INK_THRESHOLD = 200;
const MIN_SIDE = 32;
const SIDEWAYS_RATIO = 0.67;
const UPRIGHT_RATIO = 1.5;
const MIN_INK = 0.01;
const MAX_INK = 0.95;
const UPSIDE_DOWN_FACTOR = 1.2;
const UPSIDE_DOWN_DELTA = 0.08;

/** 灰度图顺时针旋转 90°（行主序）。 */
export function rotateGray90Cw(image: GrayImage): GrayImage {
    const { pixels, width, height } = image;
    const nextWidth = height;
    const nextHeight = width;
    const next = new Uint8Array(nextWidth * nextHeight);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const nx = height - 1 - y;
            const ny = x;
            next[ny * nextWidth + nx] = pixels[y * width + x];
        }
    }
    return { pixels: next, width: nextWidth, height: nextHeight };
}

export function rotateGray(image: GrayImage, clockwise: ClockwiseRotation): GrayImage {
    let current = image;
    const steps = clockwise / 90;
    for (let i = 0; i < steps; i += 1) current = rotateGray90Cw(current);
    return current;
}

function varianceOfNormalized(values: Float64Array): number {
    let max = 0;
    for (const value of values) if (value > max) max = value;
    if (max <= 0) return 0;
    let mean = 0;
    for (const value of values) mean += value / max;
    mean /= values.length;
    let sum = 0;
    for (const value of values) {
        const delta = value / max - mean;
        sum += delta * delta;
    }
    return sum / values.length;
}

export function inkProjectionScores(image: GrayImage, threshold = INK_THRESHOLD): InkProjectionScores {
    const { pixels, width, height } = image;
    const rowSums = new Float64Array(height);
    const colSums = new Float64Array(width);
    let topInk = 0;
    let botInk = 0;
    let inkCount = 0;
    const mid = Math.floor(height / 2);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (pixels[y * width + x] >= threshold) continue;
            rowSums[y] += 1;
            colSums[x] += 1;
            inkCount += 1;
            if (y < mid) topInk += 1;
            else botInk += 1;
        }
    }
    const topArea = mid * width;
    const botArea = (height - mid) * width;
    const rowVar = varianceOfNormalized(rowSums);
    const colVar = varianceOfNormalized(colSums);
    return {
        rowVar,
        colVar,
        rowOverCol: rowVar / (colVar + 1e-12),
        topInkRatio: topArea ? topInk / topArea : 0,
        botInkRatio: botArea ? botInk / botArea : 0,
        inkRatio: inkCount / (width * height),
    };
}

/**
 * 返回把画面转到文字朝上所需的顺时针角度。
 * 不确定（接近正方形投影、几乎空白）时返回 0，避免误转。
 */
export function detectContentRotationFromGray(image: GrayImage): ClockwiseRotation {
    if (image.width < MIN_SIDE || image.height < MIN_SIDE) return 0;
    const base = inkProjectionScores(image);
    if (base.inkRatio < MIN_INK || base.inkRatio > MAX_INK) return 0;

    if (base.rowOverCol >= UPRIGHT_RATIO) {
        if (
            base.topInkRatio > base.botInkRatio * UPSIDE_DOWN_FACTOR
            && base.topInkRatio - base.botInkRatio > UPSIDE_DOWN_DELTA
        ) {
            return 180;
        }
        return 0;
    }

    if (base.rowOverCol <= SIDEWAYS_RATIO) {
        const rotated90 = rotateGray(image, 90);
        const rotated270 = rotateGray(image, 270);
        const score90 = inkProjectionScores(rotated90);
        const score270 = inkProjectionScores(rotated270);
        // 转正后应出现横排文字的高行方差；再选上半页墨迹更少（页眉留白）的一侧
        const candidates: Array<{ rotation: ClockwiseRotation; top: number; rowOverCol: number }> = [
            { rotation: 90, top: score90.topInkRatio, rowOverCol: score90.rowOverCol },
            { rotation: 270, top: score270.topInkRatio, rowOverCol: score270.rowOverCol },
        ];
        candidates.sort((a, b) => a.top - b.top || b.rowOverCol - a.rowOverCol);
        return candidates[0].rotation;
    }

    return 0;
}
