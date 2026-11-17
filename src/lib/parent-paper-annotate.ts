/**
 * 把试卷页与题框、对错标记画成 PNG，供家长保存或分享。
 * 仅在浏览器中使用；样式与界面叠层保持一致，不用渐变。
 */
import type { ParentReviewVerdict, QuestionBBox } from "@/lib/parent-paper-review";

export const OVERLAY_COLORS: Record<ParentReviewVerdict, { stroke: string; fill: string; text: string; mark: string }> = {
    correct: { stroke: "#3f8f76", fill: "rgba(63, 143, 118, 0.04)", text: "#ffffff", mark: "✓" },
    wrong: { stroke: "#c45c6a", fill: "rgba(196, 92, 106, 0.04)", text: "#ffffff", mark: "✗" },
    partial: { stroke: "#c4923a", fill: "rgba(196, 146, 58, 0.05)", text: "#ffffff", mark: "△" },
};

export interface AnnotateBox {
    number: string;
    verdict: ParentReviewVerdict;
    bbox: QuestionBBox;
}

export function boxPixelRect(bbox: QuestionBBox, width: number, height: number) {
    const x = Math.round(bbox.x * width);
    const y = Math.round(bbox.y * height);
    const w = Math.max(1, Math.round(bbox.width * width));
    const h = Math.max(1, Math.round(bbox.height * height));
    return { x, y, w, h };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
        image.src = src;
    });
}

function drawRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

/** 在已有画布上绘制题框、题号徽章和对错标记 */
export function drawQuestionOverlays(
    ctx: CanvasRenderingContext2D,
    boxes: AnnotateBox[],
    width: number,
    height: number,
    pageIndex: number,
) {
    const scale = Math.max(width, height) / 800;
    const stroke = Math.max(3, Math.round(4 * scale));
    const badgeH = Math.max(22, Math.round(28 * scale));
    const markSize = Math.max(22, Math.round(30 * scale));

    for (const box of boxes) {
        if (box.bbox.pageIndex !== pageIndex) continue;
        const { x, y, w, h } = boxPixelRect(box.bbox, width, height);
        const colors = OVERLAY_COLORS[box.verdict];
        ctx.fillStyle = colors.fill;
        ctx.strokeStyle = colors.stroke;
        ctx.lineWidth = stroke;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        const label = box.number;
        ctx.font = `700 ${Math.max(14, Math.round(16 * scale))}px system-ui, sans-serif`;
        const textW = ctx.measureText(label).width;
        const badgeW = Math.max(badgeH, textW + Math.round(14 * scale));
        const badgeX = x;
        const badgeY = Math.max(0, y - badgeH);
        ctx.fillStyle = colors.stroke;
        drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, Math.round(6 * scale));
        ctx.fill();
        ctx.fillStyle = colors.text;
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(label, badgeX + badgeW / 2, badgeY + badgeH / 2);

        ctx.font = `700 ${markSize}px system-ui, sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.lineWidth = Math.max(2, Math.round(3 * scale));
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.fillStyle = colors.stroke;
        const mx = x + w - Math.round(8 * scale);
        const my = y + Math.round(6 * scale);
        ctx.strokeText(colors.mark, mx, my);
        ctx.fillText(colors.mark, mx, my);
    }
}

export async function renderAnnotatedPagePng(
    imageSrc: string,
    boxes: AnnotateBox[],
    pageIndex: number,
): Promise<Blob> {
    const image = await loadImage(imageSrc);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("CANVAS_UNSUPPORTED");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawQuestionOverlays(ctx, boxes, canvas.width, canvas.height, pageIndex);
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("CANVAS_EMPTY"))), "image/png");
    });
}

export async function shareOrDownloadPng(blob: Blob, filename: string, title?: string): Promise<"shared" | "downloaded"> {
    const file = new File([blob], filename, { type: "image/png" });
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (typeof nav.share === "function" && (!nav.canShare || nav.canShare({ files: [file] }))) {
        try {
            await nav.share({ files: [file], title: title || filename });
            return "shared";
        } catch (error) {
            if ((error as { name?: string }).name === "AbortError") throw error;
        }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return "downloaded";
}
