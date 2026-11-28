"use client";

/**
 * 浏览器端读取 PDF：数页数、把每页渲染成 JPEG 图片。
 * pdf.js（pdfjs-dist，Apache-2.0）按需动态导入 legacy 构建以兼容旧版安卓 WebView；
 * worker、wasm 解码器、CMap 和标准字体都由本站 /pdfjs/<版本>/ 同源提供（scripts/copy-pdfjs-assets.mjs），不走 CDN。
 * 不支持模块 Worker 的旧浏览器由 pdf.js 自动退回主线程解析。
 */
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfProblem } from "@/lib/folder-import";

export class PdfReadError extends Error {
    constructor(readonly code: PdfProblem, cause?: unknown) {
        super(`PDF_${code.toUpperCase()}`);
        this.name = "PdfReadError";
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

/** 渲染后长边像素：A4 约 170dpi，足够看清手写，再交给收卷压缩到 1600px */
export const PDF_RENDER_LONG_SIDE = 2000;
const MAX_SCALE = 4;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loader: Promise<{ pdfjs: PdfJs; base: string }> | null = null;

async function loadPdfJs() {
    loader ??= import("pdfjs-dist/legacy/build/pdf.mjs")
        .then((pdfjs) => {
            const base = `/pdfjs/${pdfjs.version}/`;
            // 测试环境可预先指向本地 worker；浏览器里统一用同源静态资源
            if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
            return { pdfjs, base };
        })
        .catch((error) => {
            loader = null;
            throw new PdfReadError("unsupported", error);
        });
    return loader;
}

/** 把 pdf.js 的异常归类成老师看得懂的原因 */
export function classifyPdfError(error: unknown): PdfProblem {
    if (error instanceof PdfReadError) return error.code;
    const name = (error as { name?: string } | null)?.name;
    if (name === "PasswordException") return "encrypted";
    return "corrupt";
}

async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
    const { pdfjs, base } = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    try {
        return await pdfjs.getDocument({
            data,
            wasmUrl: `${base}wasm/`,
            cMapUrl: `${base}cmaps/`,
            standardFontDataUrl: `${base}standard_fonts/`,
        }).promise;
    } catch (error) {
        throw new PdfReadError(classifyPdfError(error), error);
    }
}

/** 读取 PDF 页数；加密或损坏时抛 PdfReadError */
export async function getPdfPageCount(file: Blob): Promise<number> {
    const doc = await openPdf(file);
    try {
        return doc.numPages;
    } finally {
        void doc.loadingTask.destroy();
    }
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))), "image/jpeg", quality);
    });
}

/** 把 PDF 每页渲染成 JPEG 文件，按页序返回；逐页渲染并及时释放画布，控制内存 */
export async function renderPdfPages(file: File, options: { longSide?: number; quality?: number; maxPages?: number } = {}): Promise<File[]> {
    const longSide = options.longSide ?? PDF_RENDER_LONG_SIDE;
    const quality = options.quality ?? 0.9;
    const doc = await openPdf(file);
    const baseName = file.name.replace(/\.pdf$/i, "");
    const pages: File[] = [];
    try {
        const count = Math.min(doc.numPages, options.maxPages ?? doc.numPages);
        for (let index = 1; index <= count; index += 1) {
            const page = await doc.getPage(index);
            const unit = page.getViewport({ scale: 1 });
            const scale = Math.min(MAX_SCALE, longSide / Math.max(unit.width, unit.height));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.floor(viewport.width));
            canvas.height = Math.max(1, Math.floor(viewport.height));
            try {
                await page.render({ canvas, viewport, background: "#ffffff" }).promise;
                const blob = await canvasToJpeg(canvas, quality);
                pages.push(new File([blob], `${baseName}-p${index}.jpg`, { type: "image/jpeg", lastModified: file.lastModified }));
            } catch (error) {
                throw new PdfReadError(classifyPdfError(error), error);
            } finally {
                canvas.width = 0;
                canvas.height = 0;
                page.cleanup();
            }
        }
    } finally {
        void doc.loadingTask.destroy();
    }
    return pages;
}
