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
