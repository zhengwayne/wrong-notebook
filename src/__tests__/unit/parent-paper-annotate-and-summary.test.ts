/**
 * 家长试卷批注导出、结果汇总与状态显示工具单元测试（jsdom 环境）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    boxPixelRect,
    drawQuestionOverlays,
    loadImage,
    OVERLAY_COLORS,
    renderAnnotatedPagePng,
    shareOrDownloadPng,
    type AnnotateBox,
} from "@/lib/parent-paper-annotate";
import { parentPaperStatusClass, parentPaperStatusLabel } from "@/lib/parent-paper-status";
import { groupImportedNotebooks, summarizeParentPaperReview } from "@/lib/parent-paper-summary";

describe("parent-paper-status", () => {
    const copy = {
        pendingRecognition: "待识别",
        recognizing: "识别中",
        pendingConfirmation: "待确认",
        confirmed: "已确认",
        failed: "识别失败",
    };

    it("正确映射全部试卷状态文案与样式类", () => {
        expect(parentPaperStatusLabel(copy, "recognizing")).toBe("识别中");
        expect(parentPaperStatusLabel(copy, "pending_confirmation")).toBe("待确认");
        expect(parentPaperStatusLabel(copy, "confirmed")).toBe("已确认");
        expect(parentPaperStatusLabel(copy, "failed")).toBe("识别失败");
        expect(parentPaperStatusLabel(copy, "pending_recognition")).toBe("待识别");
        expect(parentPaperStatusLabel(copy, "unknown")).toBe("待识别");

        expect(parentPaperStatusClass("recognizing")).toContain("#6d28d9");
        expect(parentPaperStatusClass("pending_confirmation")).toContain("#f5f3ff");
        expect(parentPaperStatusClass("confirmed")).toContain("text-muted-foreground");
        expect(parentPaperStatusClass("failed")).toContain("text-destructive");
        expect(parentPaperStatusClass("pending_recognition")).toContain("bg-muted/60");
    });
});

describe("parent-paper-summary", () => {
    it("聚合对错题数、待人工确认题数、去重错因与知识点，并分组错题本计数", () => {
        const summary = summarizeParentPaperReview([
            {
                effectiveVerdict: "correct",
                confidence: 0.95,
                overrideVerdict: null,
                errorCause: null,
                knowledgePoints: ["一元二次方程", " "],
            },
            {
                effectiveVerdict: "wrong",
                confidence: 0.4,
                overrideVerdict: null,
                errorCause: " 符号看错 ",
                knowledgePoints: ["一元二次方程", "配方法"],
            },
            {
                effectiveVerdict: "partial",
                confidence: 0.3,
                overrideVerdict: "partial",
                errorCause: "符号看错",
                knowledgePoints: ["配方法", "判别式"],
            },
        ]);

        expect(summary).toEqual({
            total: 3,
            correct: 1,
            wrong: 1,
            partial: 1,
            needsConfirmation: 1,
            errorCauses: ["符号看错"],
            knowledgePoints: ["一元二次方程", "配方法", "判别式"],
        });

        expect(
            groupImportedNotebooks([
                { subjectId: "s1", subjectName: "数学" },
                { subjectId: "s1", subjectName: "数学" },
                { subjectId: "s2", subjectName: "物理" },
            ]),
        ).toEqual([
            { subjectId: "s1", subjectName: "数学", count: 2 },
            { subjectId: "s2", subjectName: "物理", count: 1 },
        ]);
    });
});

describe("parent-paper-annotate", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("正确将归一化题框转为至少 1px 的像素矩形并在 Canvas 上绘制目标页题框", () => {
        expect(boxPixelRect({ pageIndex: 0, x: 0.1, y: 0.02, width: 0.5, height: 0 }, 1000, 800)).toEqual({
            x: 100,
            y: 16,
            w: 500,
            h: 1,
        });

        const calls: string[] = [];
        const ctx = {
            fillStyle: "",
            strokeStyle: "",
            lineWidth: 0,
            font: "",
            textBaseline: "alphabetic",
            textAlign: "start",
            fillRect: vi.fn(() => calls.push("fillRect")),
            strokeRect: vi.fn(() => calls.push("strokeRect")),
            measureText: vi.fn(() => ({ width: 24 })),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            quadraticCurveTo: vi.fn(),
            closePath: vi.fn(),
            fill: vi.fn(() => calls.push("fill")),
            strokeText: vi.fn(),
            fillText: vi.fn(() => calls.push("fillText")),
        } as unknown as CanvasRenderingContext2D;

        const boxes: AnnotateBox[] = [
            { number: "1", verdict: "wrong", bbox: { pageIndex: 0, x: 0.1, y: 0.01, width: 0.3, height: 0.2 } },
            { number: "2", verdict: "partial", bbox: { pageIndex: 1, x: 0.2, y: 0.2, width: 0.4, height: 0.2 } },
        ];

        drawQuestionOverlays(ctx, boxes, 800, 1200, 0);
        expect(ctx.fillRect).toHaveBeenCalledTimes(1);
        expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
        expect(ctx.fillText).toHaveBeenCalledWith("1", expect.any(Number), expect.any(Number));
        expect(ctx.fillText).toHaveBeenCalledWith(OVERLAY_COLORS.wrong.mark, expect.any(Number), expect.any(Number));
        expect(calls).toContain("fillRect");
    });

    it("loadImage 与 renderAnnotatedPagePng 覆盖成功导出与 2d 上下文/空 Blob/加载失败降级", async () => {
        class MockImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = 400;
            naturalHeight = 600;
            width = 400;
            height = 600;
            private _src = "";
            set src(v: string) {
                this._src = v;
                queueMicrotask(() => {
                    if (v.includes("fail")) this.onerror?.();
                    else this.onload?.();
                });
            }
            get src() {
                return this._src;
            }
        }
        vi.stubGlobal("Image", MockImage);

        await expect(loadImage("data:image/png;base64,ok")).resolves.toMatchObject({ naturalWidth: 400 });
        await expect(loadImage("https://fail.invalid/bad.png")).rejects.toThrow("IMAGE_LOAD_FAILED");

        const fakeCtx = {
            drawImage: vi.fn(),
            fillRect: vi.fn(),
            strokeRect: vi.fn(),
            measureText: vi.fn(() => ({ width: 12 })),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            quadraticCurveTo: vi.fn(),
            closePath: vi.fn(),
            fill: vi.fn(),
            strokeText: vi.fn(),
            fillText: vi.fn(),
        };
        const mockBlob = new Blob(["png"], { type: "image/png" });
        const origCreateElement = document.createElement.bind(document);
        let ctxReturn: unknown = fakeCtx;
        let blobReturn: Blob | null = mockBlob;
        vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
            if (tagName === "canvas") {
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ctxReturn,
                    toBlob: (cb: (b: Blob | null) => void) => cb(blobReturn),
                } as unknown as HTMLCanvasElement;
            }
            return origCreateElement(tagName);
        }) as typeof document.createElement);

        const png = await renderAnnotatedPagePng("data:image/png;base64,ok", [], 0);
        expect(png).toBe(mockBlob);
        expect(fakeCtx.drawImage).toHaveBeenCalled();

        ctxReturn = null;
        await expect(renderAnnotatedPagePng("data:image/png;base64,ok", [], 0)).rejects.toThrow("CANVAS_UNSUPPORTED");

        ctxReturn = fakeCtx;
        blobReturn = null;
        await expect(renderAnnotatedPagePng("data:image/png;base64,ok", [], 0)).rejects.toThrow("CANVAS_EMPTY");
    });

    it("shareOrDownloadPng 优先使用 Web Share，AbortError 透传，其它异常回退下载链接", async () => {
        const blob = new Blob(["img"], { type: "image/png" });
        const shareMock = vi.fn().mockResolvedValue(undefined);
        const canShareMock = vi.fn(() => true);
        Object.defineProperty(navigator, "share", { value: shareMock, configurable: true });
        Object.defineProperty(navigator, "canShare", { value: canShareMock, configurable: true });

        expect(await shareOrDownloadPng(blob, "paper.png", "批注页")).toBe("shared");
        expect(shareMock).toHaveBeenCalledTimes(1);

        shareMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
        await expect(shareOrDownloadPng(blob, "paper.png")).rejects.toThrow("aborted");

        shareMock.mockRejectedValueOnce(new Error("share failed"));
        const createObjectURL = vi.fn(() => "blob:mock-url");
        const revokeObjectURL = vi.fn();
        vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
        const clickSpy = vi.fn();
        const origCreateElement = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
            if (tag === "a") {
                return { href: "", download: "", click: clickSpy } as unknown as HTMLAnchorElement;
            }
            return origCreateElement(tag);
        }) as typeof document.createElement);

        expect(await shareOrDownloadPng(blob, "fallback.png")).toBe("downloaded");
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    });
});
