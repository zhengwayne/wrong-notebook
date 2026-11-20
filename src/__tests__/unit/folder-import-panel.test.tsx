import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderImport } from "@/components/grading/folder-import";
import { ApiError, apiClient } from "@/lib/api-client";
import { translations } from "@/lib/translations";

vi.mock("@/contexts/LanguageContext", () => ({
    useLanguage: () => ({ t: translations.zh, language: "zh" }),
}));
vi.mock("@/lib/api-client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/api-client")>()),
    apiClient: { post: vi.fn() },
}));
vi.mock("@/lib/use-paper-images", () => ({
    compressPaperImages: vi.fn(async (files: File[]) => files.map((file) => `data:image/jpeg;base64,${btoa(encodeURIComponent(file.name))}`)),
}));
vi.mock("@/lib/feedback", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/pdf-pages", async () => {
    class PdfReadError extends Error {
        constructor(readonly code: "encrypted" | "corrupt" | "unsupported") {
            super(`PDF_${code}`);
        }
    }
    return {
        PdfReadError,
        classifyPdfError: (error: unknown) => (error instanceof PdfReadError ? error.code : "corrupt"),
        getPdfPageCount: vi.fn(async (file: File) => {
            if (file.name.includes("加密")) throw new PdfReadError("encrypted");
            return 2;
        }),
        renderPdfPages: vi.fn(async (file: File) => [1, 2].map((page) => new File(["p"], `${file.name}-p${page}.jpg`, { type: "image/jpeg" }))),
    };
});

const fi = translations.zh.grading.folderImport;
const students = [
    { id: "s1", name: "张三", studentNo: "01", classId: "c1", className: "七年级1班" },
    { id: "s2", name: "李四", studentNo: "02", classId: "c1", className: "七年级1班" },
];

function folderFile(path: string): File {
    const file = new File(["x"], path.split("/").pop()!, { type: "image/jpeg", lastModified: 1 });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
}

describe("FolderImport 面板", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    });

    it("选文件夹后预览分组与匹配，排队上传；失败的单独重试且沿用同一 importKey", async () => {
        const onUploaded = vi.fn();
        await act(async () => {
            root.render(<FolderImport taskId="task-1" students={students} submittedIds={new Set()} multiClass={false} onUploaded={onUploaded} />);
        });
        const dirInput = host.querySelector<HTMLInputElement>('[data-testid="folder-import-dir"]')!;
        expect(dirInput.hasAttribute("webkitdirectory")).toBe(true);

        const files = [
            folderFile("期中/张三/2.jpg"),
            folderFile("期中/张三/1.jpg"),
            folderFile("期中/李四/1.jpg"),
            folderFile("期中/scan_003.jpg"),
            folderFile("期中/.DS_Store"),
            folderFile("期中/说明.docx"),
        ];
        Object.defineProperty(dirInput, "files", { value: files, configurable: true });
        await act(async () => {
            dirInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await vi.waitFor(() => expect(host.querySelector('[data-testid="folder-import-summary"]')).not.toBeNull());

        expect(host.querySelector('[data-testid="folder-import-summary"]')?.textContent).toBe(
            fi.summary.replace("{papers}", "3").replace("{pages}", "4").replace("{matched}", "2"),
        );
        expect(host.textContent).toContain(fi.ignoredTitle.replace("{count}", "2"));
        const rows = [...host.querySelectorAll('[data-testid="folder-import-paper"]')];
        expect(rows.map((row) => row.querySelector("select")!.value)).toEqual(["s2", "s1", ""]);

        // scan_003 让老师手动指定为……跳过
        const scanSelect = rows[2].querySelector("select")!;
        await act(async () => {
            scanSelect.value = "__skip";
            scanSelect.dispatchEvent(new Event("change", { bubbles: true }));
        });

        const post = vi.mocked(apiClient.post);
        post.mockImplementation(async (_url, body) => {
            const payload = body as { images: string[] };
            if (payload.images.length === 2 && post.mock.calls.length <= 2) throw new ApiError(500, "", { message: "网络中断" });
            return { id: `sub-${post.mock.calls.length}`, reused: false };
        });

        const start = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(fi.start.replace("{count}", "2")))!;
        await act(async () => {
            start.click();
        });
        await vi.waitFor(() => expect(host.textContent).toContain(fi.retryFailed.replace("{count}", "1")));
        expect(post).toHaveBeenCalledTimes(2);
        const failedCall = post.mock.calls.find(([, body]) => (body as { images: string[] }).images.length === 2)!;
        const failedBody = failedCall[1] as { importKey: string; studentId: string | null; identity: unknown; images: string[] };
        // 采用按名字匹配的结果：发身份给服务端重新匹配，不当作老师手动指定
        expect(failedBody.studentId).toBeNull();
        expect(failedBody.identity).toEqual({ className: null, studentNo: null, name: "张三" });
        expect(failedBody.images).toEqual([`data:image/jpeg;base64,${btoa("1.jpg")}`, `data:image/jpeg;base64,${btoa("2.jpg")}`]);
        expect(onUploaded).toHaveBeenCalledTimes(1);

        const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(fi.retryFailed.replace("{count}", "1")))!;
        await act(async () => {
            retry.click();
        });
        await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
        const retryBody = post.mock.calls[2][1] as { importKey: string };
        expect(retryBody.importKey).toBe(failedBody.importKey);
        await vi.waitFor(() => expect(host.textContent).toContain(fi.progress.replace("{done}", "2").replace("{total}", "2")));
        expect(host.textContent).not.toContain(fi.retryFailed.replace("{count}", "1"));
    });

    it("PDF：预览按实际页数计、加密的整份不能导入；上传时逐页渲染成图片", async () => {
        await act(async () => {
            root.render(<FolderImport taskId="task-1" students={students} submittedIds={new Set()} multiClass={false} onUploaded={vi.fn()} />);
        });
        const dirInput = host.querySelector<HTMLInputElement>('[data-testid="folder-import-dir"]')!;
        const pdf = (path: string) => {
            const file = new File(["%PDF"], path.split("/").pop()!, { type: "application/pdf", lastModified: 1 });
            Object.defineProperty(file, "webkitRelativePath", { value: path });
            return file;
        };
        Object.defineProperty(dirInput, "files", { value: [pdf("扫描/张三.pdf"), pdf("扫描/李四 加密.pdf")], configurable: true });
        await act(async () => {
            dirInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await vi.waitFor(() => expect(host.querySelector('[data-testid="folder-import-summary"]')).not.toBeNull());

        expect(host.querySelector('[data-testid="folder-import-summary"]')?.textContent).toBe(
            fi.summary.replace("{papers}", "1").replace("{pages}", "2").replace("{matched}", "1"),
        );
        expect(host.textContent).toContain(fi.pdfProblem.encrypted);
        expect(host.textContent).toContain(`张三.pdf${fi.pdfPages.replace("{count}", "2")}`);
        const rows = [...host.querySelectorAll('[data-testid="folder-import-paper"]')];
        const encryptedRow = rows.find((row) => row.textContent?.includes("加密"))!;
        expect(encryptedRow.querySelector("select")!.disabled).toBe(true);
        expect(encryptedRow.querySelector("select")!.value).toBe("__skip");

        const post = vi.mocked(apiClient.post);
        post.mockResolvedValue({ id: "sub-pdf", reused: false });
        const start = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(fi.start.replace("{count}", "1")))!;
        await act(async () => {
            start.click();
        });
        await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
        const body = post.mock.calls[0][1] as { images: string[]; importKey: string };
        expect(body.images).toEqual(["张三.pdf-p1.jpg", "张三.pdf-p2.jpg"].map((name) => `data:image/jpeg;base64,${btoa(encodeURIComponent(name))}`));
        expect(body.importKey).toMatch(/^[a-f0-9]{64}$/);
    });
});
