// @vitest-environment node
/**
 * 用真实 pdf.js（legacy 构建）验证 PDF 页数读取与错误归类：正常、多页、加密、损坏。
 * 渲染依赖浏览器 canvas，在组件测试与 E2E 中覆盖。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyPdfError, getPdfPageCount, PdfReadError } from "@/lib/pdf-pages";
import { makeCorruptPdf, makePdf } from "../helpers/pdf-fixtures";

const blob = (buffer: Buffer) => new Blob([new Uint8Array(buffer)], { type: "application/pdf" });

beforeAll(async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
});

describe("pdf-pages", () => {
    it("读出页数", async () => {
        expect(await getPdfPageCount(blob(makePdf(1)))).toBe(1);
        expect(await getPdfPageCount(blob(makePdf(2)))).toBe(2);
        expect(await getPdfPageCount(blob(makePdf(9)))).toBe(9);
    });

    it("加密的 PDF 归为 encrypted", async () => {
        const error = await getPdfPageCount(blob(makePdf(2, { encrypted: true }))).catch((caught) => caught);
        expect(error).toBeInstanceOf(PdfReadError);
        expect((error as PdfReadError).code).toBe("encrypted");
    });

    it("损坏的 PDF 归为 corrupt", async () => {
        const error = await getPdfPageCount(blob(makeCorruptPdf())).catch((caught) => caught);
        expect(error).toBeInstanceOf(PdfReadError);
        expect((error as PdfReadError).code).toBe("corrupt");
    });

    it("错误归类", () => {
        expect(classifyPdfError(Object.assign(new Error("x"), { name: "PasswordException" }))).toBe("encrypted");
        expect(classifyPdfError(Object.assign(new Error("x"), { name: "InvalidPDFException" }))).toBe("corrupt");
        expect(classifyPdfError(new PdfReadError("unsupported"))).toBe("unsupported");
        expect(classifyPdfError("weird")).toBe("corrupt");
    });
});
