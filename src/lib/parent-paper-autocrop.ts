/**
 * 上传或识别前自动裁掉卷面外的桌面/背景，只把纸张区域交给模型并用于展示。
 * 使用 sharp（Apache-2.0）按亮度行/列占比找纸张边界；失败时退回原图。
 * 原图另行保留，家长仍可手动裁切。
 */
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { createLogger } from "@/lib/logger";

const logger = createLogger("parent-paper-autocrop");

const DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
const PAPER_LUMA = 145;
const ROW_FRACTION = 0.28;
const COL_FRACTION = 0.18;
const MAX_GAP_RATIO = 0.02;
const PADDING_RATIO = 0.02;
const MIN_AREA = 0.4;
const MIN_TRIM = 0.03;

export interface PaperCropBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AutoCropResult {
    imageUrl: string;
    cropped: boolean;
    crop: PaperCropBox | null;
}

/** 在灰度图上找最长的「纸张」行/列带，允许很小的间断。 */
export function longestPaperRun(fractions: number[], threshold: number, maxGap: number): { start: number; end: number } | null {
    const flags = fractions.map((value) => value >= threshold);
    let best: { start: number; end: number } | null = null;
    let start = -1;
    let gap = 0;
    const close = (end: number) => {
        if (start < 0) return;
        const span = end - start + 1;
        if (!best || span > best.end - best.start + 1) best = { start, end };
    };
    for (let i = 0; i < flags.length; i++) {
        if (flags[i]) {
            if (start < 0) start = i;
            gap = 0;
        } else if (start >= 0) {
            gap += 1;
            if (gap > maxGap) {
                close(i - gap - 1);
                start = -1;
                gap = 0;
            }
        }
    }
    if (start >= 0) close(flags.length - 1);
    return best;
}

export function detectPaperBounds(
    gray: Uint8Array | Buffer,
    width: number,
    height: number,
): PaperCropBox | null {
    if (width < 8 || height < 8 || gray.length < width * height) return null;

    const rowFrac = new Array<number>(height).fill(0);
    const colHits = new Array<number>(width).fill(0);
    for (let y = 0; y < height; y++) {
        let hits = 0;
        const row = y * width;
        for (let x = 0; x < width; x++) {
            if (gray[row + x] >= PAPER_LUMA) {
                hits += 1;
                colHits[x] += 1;
            }
        }
        rowFrac[y] = hits / width;
    }
    const colFrac = colHits.map((hits) => hits / height);

    const rowRun = longestPaperRun(rowFrac, ROW_FRACTION, Math.max(2, Math.round(height * MAX_GAP_RATIO)));
    const colRun = longestPaperRun(colFrac, COL_FRACTION, Math.max(2, Math.round(width * MAX_GAP_RATIO)));
    if (!rowRun || !colRun) return null;

    const padX = Math.max(2, Math.round(width * PADDING_RATIO));
    const padY = Math.max(2, Math.round(height * PADDING_RATIO));
    const left = Math.max(0, colRun.start - padX);
    const top = Math.max(0, rowRun.start - padY);
    const right = Math.min(width, colRun.end + 1 + padX);
    const bottom = Math.min(height, rowRun.end + 1 + padY);
    const cropW = right - left;
    const cropH = bottom - top;
    const area = (cropW * cropH) / (width * height);
    if (cropW < 16 || cropH < 16 || area < MIN_AREA) return null;
    const trimmed = 1 - area;
    if (trimmed < MIN_TRIM) return null; // 几乎没有背景，不必裁

    return {
        x: left / width,
        y: top / height,
        width: cropW / width,
        height: cropH / height,
    };
}

async function loadSharp() {
    return (await import("sharp")).default;
}

/**
 * 按 EXIF 转正后再检测纸张并裁切。失败或无需裁切时返回原图。
 */
export async function autoCropPaperImage(imageUrl: string): Promise<AutoCropResult> {
    if (!DATA_URL.test(imageUrl)) return { imageUrl, cropped: false, crop: null };
    try {
        const sharp = await loadSharp();
        const { base64 } = splitDataUrl(imageUrl);
        const buffer = Buffer.from(base64, "base64");
        // rotate() 无参时按 EXIF 转正，保证模型看到的方向与展示一致
        const oriented = sharp(buffer).rotate();
        const { data, info } = await oriented.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
        const crop = detectPaperBounds(data, info.width, info.height);
        if (!crop) return { imageUrl, cropped: false, crop: null };

        const left = Math.max(0, Math.min(info.width - 1, Math.round(crop.x * info.width)));
        const top = Math.max(0, Math.min(info.height - 1, Math.round(crop.y * info.height)));
        const width = Math.max(1, Math.min(info.width - left, Math.round(crop.width * info.width)));
        const height = Math.max(1, Math.min(info.height - top, Math.round(crop.height * info.height)));
        if (width < 16 || height < 16) return { imageUrl, cropped: false, crop: null };

        const cropped = await sharp(buffer).rotate().extract({ left, top, width, height }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
        return {
            imageUrl: `data:image/jpeg;base64,${cropped.toString("base64")}`,
            cropped: true,
            crop,
        };
    } catch (error) {
        logger.warn({ error }, "Failed to auto-crop parent paper page; using the original image");
        return { imageUrl, cropped: false, crop: null };
    }
}
