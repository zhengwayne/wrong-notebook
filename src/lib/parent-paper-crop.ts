/**
 * 从试卷页图按归一化 bbox 裁出单题。使用已有的 sharp（Apache-2.0）；
 * 失败时退回整页，避免入库中断。
 *
 * sharp 已是 Next.js 的依赖。桌面版 asar 关闭，并把 server/node_modules 整包拷入
 * extraResources；服务端由 ELECTRON_RUN_AS_NODE 运行，可加载与系统 Node 相同 ABI
 * 的 sharp 预编译二进制。standalone 打包时把 sharp 列入 serverExternalPackages
 * 和 EXTRA_RUNTIME_PACKAGES，以免追踪遗漏原生模块。
 */
import { splitDataUrl } from "@/lib/ai/exam-paper-read";
import { createLogger } from "@/lib/logger";
import { clampNormalizedBBox, type QuestionBBox } from "@/lib/parent-paper-review";

const logger = createLogger("parent-paper-crop");

export interface CropResult {
    imageUrl: string;
    cropped: boolean;
}

const DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,/i;

export async function cropDataUrlRegion(
    imageUrl: string,
    bbox: Pick<QuestionBBox, "x" | "y" | "width" | "height">,
): Promise<CropResult> {
    const clamped = clampNormalizedBBox({ pageIndex: 0, ...bbox });
    if (!clamped || !DATA_URL.test(imageUrl)) return { imageUrl, cropped: false };

    try {
        const sharp = (await import("sharp")).default;
        const { base64 } = splitDataUrl(imageUrl);
        const buffer = Buffer.from(base64, "base64");
        const image = sharp(buffer);
        const metadata = await image.metadata();
        const pageWidth = metadata.width;
        const pageHeight = metadata.height;
        if (!pageWidth || !pageHeight) return { imageUrl, cropped: false };

        const left = Math.max(0, Math.min(pageWidth - 1, Math.round(clamped.x * pageWidth)));
        const top = Math.max(0, Math.min(pageHeight - 1, Math.round(clamped.y * pageHeight)));
        const width = Math.max(1, Math.min(pageWidth - left, Math.round(clamped.width * pageWidth)));
        const height = Math.max(1, Math.min(pageHeight - top, Math.round(clamped.height * pageHeight)));
        if (width < 2 || height < 2) return { imageUrl, cropped: false };

        const cropped = await image.extract({ left, top, width, height }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
        return { imageUrl: `data:image/jpeg;base64,${cropped.toString("base64")}`, cropped: true };
    } catch (error) {
        logger.warn({ error }, "Failed to crop parent paper question; falling back to the full page");
        return { imageUrl, cropped: false };
    }
}
