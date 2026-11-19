/**
 * 服务端试卷朝向：在 normalizeImage（EXIF 转正并剥离元数据）之后，
 * 检测内容是否仍侧着，并用 sharp.rotate(顺时针) 转正后再识卷/裁切。
 */
import sharp from "sharp";
import { detectContentRotationFromGray, type GrayImage } from "@/lib/page-orientation";
import type { ClockwiseRotation } from "@/lib/parent-paper-bbox";
import { normalizeImageDataUrl, type NormalizedImageResult } from "@/lib/server/image-normalize";

const ANALYZE_MAX_EDGE = 512;

export interface UprightImageResult extends NormalizedImageResult {
    /** 在 EXIF 转正之后又施加的内容旋转 */
    contentRotation: ClockwiseRotation;
}

function grayFromRaw(data: Buffer, width: number, height: number, channels: number): GrayImage {
    const pixels = new Uint8Array(width * height);
    if (channels === 1) {
        pixels.set(data.subarray(0, width * height));
        return { pixels, width, height };
    }
    for (let i = 0, p = 0; p < pixels.length; i += channels, p += 1) {
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? r;
        const b = data[i + 2] ?? r;
        pixels[p] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return { pixels, width, height };
}

export async function detectContentRotation(input: Buffer): Promise<ClockwiseRotation> {
    const { data, info } = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
        .rotate() // 若输入仍带 EXIF，先按方向转正再检测内容朝向
        .resize({ width: ANALYZE_MAX_EDGE, height: ANALYZE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return detectContentRotationFromGray(grayFromRaw(data, info.width, info.height, info.channels ?? 1));
}

async function rotateBufferToResult(buffer: Buffer, clockwise: Exclude<ClockwiseRotation, 0>): Promise<NormalizedImageResult> {
    const { data, info } = await sharp(buffer, { failOn: "error" })
        .rotate(clockwise)
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    const mimeType = "image/jpeg" as const;
    const base64 = data.toString("base64");
    return {
        buffer: data,
        base64,
        mimeType,
        dataUrl: `data:${mimeType};base64,${base64}`,
        width: info.width,
        height: info.height,
    };
}

export async function rotateImageDataUrl(dataUrl: string, clockwise: ClockwiseRotation): Promise<NormalizedImageResult> {
    if (clockwise === 0) return normalizeImageDataUrl(dataUrl);
    const current = await normalizeImageDataUrl(dataUrl);
    return rotateBufferToResult(current.buffer, clockwise);
}

/** 规范化（EXIF 转正+剥离）后再按内容朝向转正，保证送给模型和展示的图方向一致。 */
export async function uprightImageDataUrl(dataUrl: string): Promise<UprightImageResult> {
    const normalized = await normalizeImageDataUrl(dataUrl);
    const contentRotation = await detectContentRotation(normalized.buffer);
    if (contentRotation === 0) {
        return { ...normalized, contentRotation };
    }
    const rotated = await rotateBufferToResult(normalized.buffer, contentRotation);
    return { ...rotated, contentRotation };
}
