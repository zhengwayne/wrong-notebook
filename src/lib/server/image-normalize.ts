/**
 * 服务端图片规范化（安全边界）：
 * 使用 sharp 解码验证真实图片格式（jpeg/png/webp/gif），按 EXIF 方向自动转正，
 * 限制最长边，剥离全部 EXIF/IPTC/XMP 元数据（防 GPS/设备隐私泄露）并重新编码。
 */
import sharp, { type Metadata } from 'sharp';

export type AllowedImageFormat = 'jpeg' | 'png' | 'webp' | 'gif';
export type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export const DEFAULT_MAX_EDGE = 2560;
export const MAX_INPUT_PIXELS = 40_000_000;

const MIME_BY_FORMAT: Record<AllowedImageFormat, AllowedImageMime> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
};

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\r\n\s]+)$/i;
const RAW_BASE64_RE = /^[A-Za-z0-9+/=\r\n\s]+$/;

export interface NormalizeImageOptions {
    maxEdge?: number;
    allowedFormats?: readonly AllowedImageFormat[];
}

export interface NormalizedImageResult {
    buffer: Buffer;
    base64: string;
    mimeType: AllowedImageMime;
    dataUrl: string;
    width: number;
    height: number;
}

export class ImageValidationError extends Error {
    readonly code: 'INVALID_IMAGE_URL' | 'UNSUPPORTED_IMAGE_FORMAT' | 'IMAGE_TOO_LARGE' | 'CORRUPTED_IMAGE';

    constructor(
        code: 'INVALID_IMAGE_URL' | 'UNSUPPORTED_IMAGE_FORMAT' | 'IMAGE_TOO_LARGE' | 'CORRUPTED_IMAGE',
        message?: string,
    ) {
        super(message ?? code);
        this.name = 'ImageValidationError';
        this.code = code;
    }
}

/** 校验并规范化图片 Buffer：转正、限制最长边、剥离全部 EXIF/IPTC/XMP 元数据、重新编码 */
export async function normalizeImageBuffer(
    input: Buffer,
    options: NormalizeImageOptions = {},
): Promise<NormalizedImageResult> {
    if (!Buffer.isBuffer(input) || input.length === 0) {
        throw new ImageValidationError('CORRUPTED_IMAGE', 'Empty image buffer');
    }

    const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
    const allowedFormats: readonly AllowedImageFormat[] = options.allowedFormats ?? ['jpeg', 'png', 'webp', 'gif'];

    let metadata: Metadata;
    try {
        metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.toLowerCase().includes('pixel limit')) {
            throw new ImageValidationError('IMAGE_TOO_LARGE', 'Image exceeds maximum pixel limit');
        }
        throw new ImageValidationError('CORRUPTED_IMAGE', 'Failed to decode image');
    }

    const format = metadata.format;
    if (!format || !(allowedFormats as readonly string[]).includes(format)) {
        throw new ImageValidationError('UNSUPPORTED_IMAGE_FORMAT', `Unsupported image format: ${format ?? 'unknown'}`);
    }
    const typedFormat = format as AllowedImageFormat;

    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS) {
        throw new ImageValidationError('IMAGE_TOO_LARGE', 'Image dimensions invalid or exceed pixel limit');
    }

    try {
        // 默认不调用 .withMetadata()，从而彻底清除 EXIF（含 GPS）、IPTC 和 XMP 元数据
        let pipeline = sharp(input, {
            limitInputPixels: MAX_INPUT_PIXELS,
            failOn: 'error',
            ...(typedFormat === 'gif' ? { animated: true } : {}),
        })
            .rotate()
            .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });

        if (typedFormat === 'jpeg') {
            pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
        } else if (typedFormat === 'png') {
            pipeline = pipeline.png({ compressionLevel: 8 });
        } else if (typedFormat === 'webp') {
            pipeline = pipeline.webp({ quality: 85 });
        } else {
            pipeline = pipeline.gif();
        }

        const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
        const mimeType = MIME_BY_FORMAT[typedFormat];
        const base64 = data.toString('base64');
        return {
            buffer: data,
            base64,
            mimeType,
            dataUrl: `data:${mimeType};base64,${base64}`,
            width: info.width,
            height: info.height,
        };
    } catch (error) {
        if (error instanceof ImageValidationError) throw error;
        throw new ImageValidationError('CORRUPTED_IMAGE', 'Failed to normalize image');
    }
}

/** 校验并规范化 data:image/(png|jpeg|webp|gif);base64,... URL */
export async function normalizeImageDataUrl(
    raw: string,
    options: NormalizeImageOptions = {},
): Promise<NormalizedImageResult> {
    if (typeof raw !== 'string') {
        throw new ImageValidationError('INVALID_IMAGE_URL', 'Image data URL must be a string');
    }
    const trimmed = raw.trim();
    const match = DATA_URL_RE.exec(trimmed);
    if (!match) {
        throw new ImageValidationError('INVALID_IMAGE_URL', 'Only base64 png/jpeg/webp/gif data URLs are allowed');
    }
    const base64Payload = match[2].replace(/\s+/g, '');
    const buffer = Buffer.from(base64Payload, 'base64');
    return normalizeImageBuffer(buffer, options);
}

/** 接收 data URL 或裸 base64 字符串（用于 analyze / reanswer 接口） */
export async function normalizeImageInput(
    raw: string,
    options: NormalizeImageOptions = {},
): Promise<NormalizedImageResult> {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new ImageValidationError('INVALID_IMAGE_URL', 'Empty image input');
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('data:')) {
        return normalizeImageDataUrl(trimmed, options);
    }
    if (!RAW_BASE64_RE.test(trimmed)) {
        throw new ImageValidationError('INVALID_IMAGE_URL', 'Invalid base64 image input');
    }
    const buffer = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64');
    return normalizeImageBuffer(buffer, options);
}

/** 允许空串/null/undefined 返回空串；非空则强制走 normalizeImageDataUrl */
export async function normalizeOptionalImageDataUrl(
    raw: string | null | undefined,
    options: NormalizeImageOptions = {},
): Promise<string> {
    if (raw === null || raw === undefined) return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const result = await normalizeImageDataUrl(trimmed, options);
    return result.dataUrl;
}

export interface StitchOptions {
    /** 拼图最长边，默认与保存错题时的限边一致，保存时不会再被缩小 */
    maxEdge?: number;
    /** 图片之间的白色间隔（像素） */
    gap?: number;
}

/**
 * 把一道跨页题的几张照片（已规范化）按顺序拼成一张图，作为错题原图保存：
 * 竖排（上下接）和横排（左右并排）里选每页能保留更多像素的一种；最长边不超过 maxEdge，输出 JPEG。
 */
export async function stitchImages(
    pages: ReadonlyArray<Pick<NormalizedImageResult, 'buffer' | 'width' | 'height'>>,
    options: StitchOptions = {},
): Promise<NormalizedImageResult> {
    if (pages.length === 0) throw new ImageValidationError('CORRUPTED_IMAGE', 'No images to stitch');
    const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
    const gap = options.gap ?? 16;

    // 竖排：统一宽度 W；横排：统一高度 H。各自求出满足最长边限制的缩放比例，取更大的
    const refWidth = Math.max(...pages.map((p) => p.width));
    const refHeight = Math.max(...pages.map((p) => p.height));
    const gaps = gap * (pages.length - 1);
    const verticalHeight = pages.reduce((sum, p) => sum + (p.height * refWidth) / p.width, 0);
    const vScale = Math.min(1, maxEdge / refWidth, (maxEdge - gaps) / verticalHeight);
    const horizontalWidth = pages.reduce((sum, p) => sum + (p.width * refHeight) / p.height, 0);
    const hScale = Math.min(1, maxEdge / refHeight, (maxEdge - gaps) / horizontalWidth);
    const vertical = vScale >= hScale;

    const layout: Array<{ input: Buffer; left: number; top: number }> = [];
    let offset = 0;
    let canvasWidth = 0;
    let canvasHeight = 0;
    for (const page of pages) {
        const width = vertical ? Math.max(1, Math.round(refWidth * vScale)) : Math.max(1, Math.round((page.width * refHeight * hScale) / page.height));
        const height = vertical ? Math.max(1, Math.round((page.height * refWidth * vScale) / page.width)) : Math.max(1, Math.round(refHeight * hScale));
        const input = await sharp(page.buffer, { limitInputPixels: MAX_INPUT_PIXELS }).resize({ width, height, fit: 'fill' }).toBuffer();
        layout.push({ input, left: vertical ? 0 : offset, top: vertical ? offset : 0 });
        offset += (vertical ? height : width) + gap;
        canvasWidth = vertical ? Math.max(canvasWidth, width) : offset - gap;
        canvasHeight = vertical ? offset - gap : Math.max(canvasHeight, height);
    }

    const data = await sharp({
        create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
        .composite(layout)
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    const base64 = data.toString('base64');
    return {
        buffer: data,
        base64,
        mimeType: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${base64}`,
        width: canvasWidth,
        height: canvasHeight,
    };
}
