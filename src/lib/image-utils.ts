import { frontendLogger } from "@/lib/frontend-logger";
import { heicUnsupportedError, isHeicFile } from "@/lib/heic";

interface DecodedImage {
    source: CanvasImageSource;
    width: number;
    height: number;
    close: () => void;
}

async function decodeImageFile(file: File): Promise<DecodedImage> {
    if (typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
            return {
                source: bitmap,
                width: bitmap.width,
                height: bitmap.height,
                close: () => bitmap.close(),
            };
        } catch {
            // 继续尝试用 Image 解码（部分浏览器只能这样打开 HEIC）
        }
    }

    const url = URL.createObjectURL(file);
    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
            img.src = url;
        });
        return {
            source: image,
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
            close: () => URL.revokeObjectURL(url),
        };
    } catch (error) {
        URL.revokeObjectURL(url);
        if (isHeicFile(file)) throw heicUnsupportedError();
        throw error instanceof Error ? error : new Error("图片加载失败");
    }
}

function canvasToJpeg(canvas: HTMLCanvasElement, maxSizeMB: number, quality: number, fileSize?: number): string {
    let currentQuality = quality;
    let compressed = canvas.toDataURL("image/jpeg", currentQuality);
    let sizeInMB = (compressed.length * 3) / 4 / 1024 / 1024;

    while (sizeInMB > maxSizeMB && currentQuality > 0.1) {
        currentQuality -= 0.1;
        compressed = canvas.toDataURL("image/jpeg", currentQuality);
        sizeInMB = (compressed.length * 3) / 4 / 1024 / 1024;
        frontendLogger.info("[ImageCompress]", "Compression step", { quality: Number(currentQuality.toFixed(1)), sizeMB: Number(sizeInMB.toFixed(2)) }, { sendToBackend: false });
        if (sizeInMB <= maxSizeMB) break;
    }

    if (fileSize != null) {
        frontendLogger.info("[ImageCompress]", "Compression finished", {
            originalMB: Number((fileSize / 1024 / 1024).toFixed(2)),
            compressedMB: Number(sizeInMB.toFixed(2)),
        });
    }
    return compressed;
}

const DEFAULT_MAX_SIZE_MB = 1;
const DEFAULT_MAX_WIDTH = 1920;

function isStandardJpeg(file: File): boolean {
    const type = file.type.toLowerCase();
    if (type === "image/jpeg" || type === "image/jpg") return true;
    if (!type && /\.(jpe?g)$/i.test(file.name)) return true;
    return false;
}

/** 轻量读取 JPEG APP1 EXIF Orientation（未含 EXIF 或解析失败时返回 1） */
export async function readJpegExifOrientation(file: Blob): Promise<number> {
    if (typeof file.arrayBuffer !== "function") return 1;
    try {
        const slice = file.slice(0, Math.min(file.size || 65536, 65536));
        const buffer = await slice.arrayBuffer();
        const view = new DataView(buffer);
        if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;

        let offset = 2;
        while (offset + 4 <= view.byteLength) {
            if (view.getUint8(offset) !== 0xff) break;
            const marker = view.getUint8(offset + 1);
            if (marker === 0xda || marker === 0xd9) break;
            const length = view.getUint16(offset + 2, false);
            if (marker === 0xe1 && offset + 12 <= view.byteLength) {
                // "Exif\0\0"
                if (view.getUint32(offset + 4, false) === 0x45786966 && view.getUint16(offset + 8, false) === 0x0000) {
                    const tiff = offset + 10;
                    if (tiff + 8 > view.byteLength) return 1;
                    const little = view.getUint16(tiff, false) === 0x4949;
                    const firstIfdOffset = view.getUint32(tiff + 4, little);
                    const ifdStart = tiff + firstIfdOffset;
                    if (ifdStart + 2 > view.byteLength) return 1;
                    const entries = view.getUint16(ifdStart, little);
                    for (let i = 0; i < entries; i++) {
                        const entry = ifdStart + 2 + i * 12;
                        if (entry + 12 > view.byteLength) break;
                        if (view.getUint16(entry, little) === 0x0112) {
                            return view.getUint16(entry + 8, little) || 1;
                        }
                    }
                }
            }
            if (length < 2) break;
            offset += 2 + length;
        }
    } catch {
        // 无法读取时按无旋转处理
    }
    return 1;
}

function drawNormalizedToJpeg(
    decoded: DecodedImage,
    maxSizeMB: number,
    maxWidth: number,
    quality: number,
    fileSize?: number,
): string {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 上下文");

    let width = decoded.width;
    let height = decoded.height;
    if (width > maxWidth) {
        height = Math.max(1, Math.round((height * maxWidth) / width));
        width = maxWidth;
    }
    canvas.width = width;
    canvas.height = height;
    // 转 JPEG 前先填充白底，避免透明 PNG/WebP 导出后出现黑色背景
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);
    return canvasToJpeg(canvas, maxSizeMB, quality, fileSize);
}

/**
 * 压缩图片文件
 * @param file 原始图片文件
 * @param maxSizeMB 最大文件大小（MB），默认 1MB
 * @param maxWidth 最大宽度，默认 1920px
 * @param quality 压缩质量 0-1，默认 0.8
 * @returns 压缩后的 Base64 字符串
 */
export async function compressImage(
    file: File,
    maxSizeMB: number = DEFAULT_MAX_SIZE_MB,
    maxWidth: number = DEFAULT_MAX_WIDTH,
    quality: number = 0.8
): Promise<string> {
    const decoded = await decodeImageFile(file);
    try {
        return drawNormalizedToJpeg(decoded, maxSizeMB, maxWidth, quality, file.size);
    } finally {
        decoded.close();
    }
}

/**
 * 检查并规范化图片（即使小于 1MB 也会校验透明底风险、EXIF 方向与最大宽度）。
 */
export async function processImageFile(file: File): Promise<string> {
    const fileSizeMB = file.size / 1024 / 1024;
    const isJpeg = isStandardJpeg(file);

    frontendLogger.info("[ImageCompress]", "File size checked", {
        sizeMB: Number(fileSizeMB.toFixed(2)),
        heic: isHeicFile(file),
        isJpeg,
    }, { sendToBackend: false });

    if (isHeicFile(file) || fileSizeMB > DEFAULT_MAX_SIZE_MB || !isJpeg) {
        frontendLogger.info("[ImageCompress]", "File needs conversion or compression", undefined, { sendToBackend: false });
        return await compressImage(file, DEFAULT_MAX_SIZE_MB, DEFAULT_MAX_WIDTH);
    }

    const orientation = await readJpegExifOrientation(file);
    const decoded = await decodeImageFile(file);
    try {
        const needsResizeOrRotate = orientation > 1 || decoded.width > DEFAULT_MAX_WIDTH || decoded.height > DEFAULT_MAX_WIDTH;
        if (needsResizeOrRotate) {
            frontendLogger.info("[ImageCompress]", "Small JPEG needs resize or orientation normalization", {
                orientation,
                width: decoded.width,
                height: decoded.height,
            }, { sendToBackend: false });
            return drawNormalizedToJpeg(decoded, DEFAULT_MAX_SIZE_MB, DEFAULT_MAX_WIDTH, 0.8, file.size);
        }
    } finally {
        decoded.close();
    }

    frontendLogger.info("[ImageCompress]", "File size OK, no compression needed", undefined, { sendToBackend: false });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
