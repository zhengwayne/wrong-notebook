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
            const bitmap = await createImageBitmap(file);
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
    maxSizeMB: number = 1,
    maxWidth: number = 1920,
    quality: number = 0.8
): Promise<string> {
    const decoded = await decodeImageFile(file);
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("无法获取 Canvas 上下文");

        let width = decoded.width;
        let height = decoded.height;
        if (width > maxWidth) {
            height = (height * maxWidth) / width;
            width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(decoded.source, 0, 0, width, height);
        return canvasToJpeg(canvas, maxSizeMB, quality, file.size);
    } finally {
        decoded.close();
    }
}

/**
 * 检查并压缩图片（如果需要）
 * HEIC 即使小于阈值也会转成 JPEG，避免后续无法显示。
 * @param file 图片文件
 * @returns Base64 字符串
 */
export async function processImageFile(file: File): Promise<string> {
    const fileSizeMB = file.size / 1024 / 1024;
    const threshold = 1;

    frontendLogger.info("[ImageCompress]", "File size checked", { sizeMB: Number(fileSizeMB.toFixed(2)), heic: isHeicFile(file) }, { sendToBackend: false });

    if (isHeicFile(file) || fileSizeMB > threshold) {
        frontendLogger.info("[ImageCompress]", "File needs conversion or compression", undefined, { sendToBackend: false });
        return await compressImage(file, threshold);
    }

    frontendLogger.info("[ImageCompress]", "File size OK, no compression needed", undefined, { sendToBackend: false });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
