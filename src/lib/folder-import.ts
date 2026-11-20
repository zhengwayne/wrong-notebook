/**
 * 老师批量导入扫描卷（纯逻辑，浏览器与测试共用）：
 * 把选择/拖入的文件按目录结构分成「一份卷子」，并用文件夹名或文件名匹配花名册。
 *
 * 分组规则：
 * - 选择或拖入的单个外层文件夹会被剥掉（它只是容器）；
 * - 外层下的每个子文件夹 = 一份卷子，子文件夹内（含更深层）的图片按路径自然排序作为页序；
 * - 外层根目录下散放的每张图片、每个 PDF = 一份卷子（PDF 的每一页是这份的一页）；
 * - 子文件夹里的 PDF 按文件名排在它的位置上，展开成连续几页并入这份（如「1.jpg、2.pdf(2 页)、3.jpg」共 4 页）；
 * - 隐藏文件、系统文件、非图片非 PDF、超过大小上限的文件忽略并列出原因；
 * - 一份超过页数上限，或含加密/损坏的 PDF 时，整份标记为不可导入，不截断。
 */
import { MAX_PAGES_PER_PAPER, MAX_PAPERS_PER_UPLOAD } from "@/lib/grading-api";
import { matchStudent, type PaperIdentity, type RosterStudent } from "@/lib/student-match";

/** 单张图片原文件上限（与单题上传一致） */
export const FOLDER_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 单个 PDF 原文件上限（多页扫描件通常比单张图片大） */
export const FOLDER_IMPORT_MAX_PDF_BYTES = 50 * 1024 * 1024;
/** 一次导入最多份数（与收卷批量上传一致） */
export const FOLDER_IMPORT_MAX_PAPERS = MAX_PAPERS_PER_UPLOAD;
/** 每份最多页数（与收卷单份一致） */
export const FOLDER_IMPORT_MAX_PAGES = MAX_PAGES_PER_PAPER;
/** 一次导入的原文件总大小上限 */
export const FOLDER_IMPORT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** 同时上传的份数 */
export const FOLDER_IMPORT_CONCURRENCY = 2;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif"]);
const SYSTEM_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini", "icon\r"]);

export interface ImportSourceFile<F = File> {
    file: F;
    /** 相对路径，含选择的外层文件夹名，用 / 分隔 */
    path: string;
    size: number;
    lastModified: number;
}

export type IgnoreReason = "hidden" | "system" | "unsupported" | "too_large";

/** PDF 读不出来的原因：加密、损坏、浏览器无法加载 pdf.js */
export type PdfProblem = "encrypted" | "corrupt" | "unsupported";

/** 预先读出的 PDF 信息：页数或问题，按 normalizeImportPath 后的路径索引 */
export type PdfInfo = Map<string, number | PdfProblem>;

export interface IgnoredFile {
    path: string;
    reason: IgnoreReason;
}

export interface ImportPaper<F = File> {
    /** 分组键：子文件夹路径或散放文件路径 */
    key: string;
    /** 用于匹配学生和展示的名字（子文件夹名或去掉扩展名的文件名） */
    label: string;
    /** 按页序排列的源文件；PDF 占一项，展开后可能是多页 */
    pages: ImportSourceFile<F>[];
    /** 展开 PDF 后的实际页数 */
    pageCount: number;
    /** 超过页数上限，不能导入 */
    tooManyPages: boolean;
    /** 含读不出来的 PDF，不能导入 */
    pdfProblem: PdfProblem | null;
}

export interface GroupResult<F = File> {
    papers: ImportPaper<F>[];
    ignored: IgnoredFile[];
    /** 可导入份数超过上限时被截掉的份（按顺序在后面的） */
    overflow: ImportPaper<F>[];
    totalBytes: number;
    tooLarge: boolean;
}

const collator = new Intl.Collator(["zh", "en"], { numeric: true, sensitivity: "base" });

/** 自然排序：page2 在 page10 前面 */
export function naturalCompare(a: string, b: string): number {
    return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function segments(path: string): string[] {
    return path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0 && part !== ".");
}

/** 统一路径写法（/ 分隔、去掉空段），用作 PdfInfo 的键 */
export function normalizeImportPath(path: string): string {
    return segments(path).join("/");
}

export function isPdfPath(path: string): boolean {
    return extensionOf(path) === "pdf";
}

function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stripExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/** 判断一个文件是否应忽略；返回 null 表示可导入 */
export function classifyFile(path: string, size: number, maxFileBytes = FOLDER_IMPORT_MAX_FILE_BYTES, maxPdfBytes = FOLDER_IMPORT_MAX_PDF_BYTES): IgnoreReason | null {
    const parts = segments(path);
    const name = parts[parts.length - 1] || "";
    if (SYSTEM_FILES.has(name.toLowerCase()) || parts.some((part) => part === "__MACOSX")) return "system";
    if (parts.some((part) => part.startsWith("."))) return "hidden";
    const ext = extensionOf(name);
    if (ext === "pdf") return size > maxPdfBytes ? "too_large" : null;
    if (!IMAGE_EXTENSIONS.has(ext)) return "unsupported";
    if (size > maxFileBytes) return "too_large";
    return null;
}

/** 按目录结构把文件分成份；输入顺序无关 */
export function groupImportFiles<F>(
    files: ImportSourceFile<F>[],
    options: { maxPapers?: number; maxPages?: number; maxTotalBytes?: number; maxFileBytes?: number; maxPdfBytes?: number; pdfInfo?: PdfInfo } = {},
): GroupResult<F> {
    const maxPapers = options.maxPapers ?? FOLDER_IMPORT_MAX_PAPERS;
    const maxPages = options.maxPages ?? FOLDER_IMPORT_MAX_PAGES;
    const maxTotalBytes = options.maxTotalBytes ?? FOLDER_IMPORT_MAX_TOTAL_BYTES;
    const ignored: IgnoredFile[] = [];
    const kept: Array<{ source: ImportSourceFile<F>; parts: string[] }> = [];
    for (const source of files) {
        const parts = segments(source.path);
        if (parts.length === 0) continue;
        const reason = classifyFile(source.path, source.size, options.maxFileBytes, options.maxPdfBytes);
        if (reason) ignored.push({ path: parts.join("/"), reason });
        else kept.push({ source, parts });
    }

    // 所有文件都在同一个外层文件夹里时，剥掉这层容器（可能嵌套多层单一容器）
    let strip = 0;
    while (kept.length > 0) {
        const first = kept[0].parts[strip];
        if (kept.every((item) => item.parts.length > strip + 1 && item.parts[strip] === first)) strip += 1;
        else break;
    }
    const groups = new Map<string, ImportPaper<F>>();
    for (const { source, parts } of kept) {
        const rest = parts.slice(strip);
        const isLoose = rest.length === 1;
        const key = isLoose ? parts.join("/") : parts.slice(0, strip + 1).join("/");
        const label = isLoose ? stripExtension(rest[0]) : rest[0];
        const paper = groups.get(key) ?? { key, label, pages: [], pageCount: 0, tooManyPages: false, pdfProblem: null };
        paper.pages.push(source);
        groups.set(key, paper);
    }

    const all = [...groups.values()];
    for (const paper of all) {
        paper.pages.sort((a, b) => naturalCompare(segments(a.path).join("/"), segments(b.path).join("/")));
        for (const page of paper.pages) {
            if (!isPdfPath(page.path)) {
                paper.pageCount += 1;
                continue;
            }
            // 还没读页数的 PDF 先按 1 页估计
            const info = options.pdfInfo?.get(normalizeImportPath(page.path));
            if (typeof info === "number") paper.pageCount += Math.max(1, info);
            else if (info) {
                paper.pdfProblem = paper.pdfProblem ?? info;
                paper.pageCount += 1;
            } else paper.pageCount += 1;
        }
        paper.tooManyPages = paper.pageCount > maxPages;
    }
    all.sort((a, b) => naturalCompare(a.key, b.key));

    const importable = all.filter((paper) => !paper.tooManyPages && !paper.pdfProblem);
    const blocked = all.filter((paper) => paper.tooManyPages || paper.pdfProblem);
    const accepted = importable.slice(0, maxPapers);
    const overflow = importable.slice(maxPapers);
    const totalBytes = accepted.reduce((sum, paper) => sum + paper.pages.reduce((s, page) => s + page.size, 0), 0);
    return {
        papers: [...accepted, ...blocked].sort((a, b) => naturalCompare(a.key, b.key)),
        ignored,
        overflow,
        totalBytes,
        tooLarge: totalBytes > maxTotalBytes,
    };
}

/** 文件名里常见的扫描仪/相机前缀与无意义词，不当作姓名 */
const NOISE_WORDS = new Set([
    "scan", "scanned", "img", "image", "dsc", "dscn", "photo", "pic", "page", "pages", "p", "doc", "document",
    "paper", "exam", "test", "quiz", "copy", "file", "new", "untitled", "screenshot", "wechat", "mmexport", "cam", "camera",
]);
const CJK_NOISE = /(扫描件|扫描|试卷|答卷|答题卡|卷子|第.{0,3}页|页|图片|照片|截图|副本|正面|反面|背面)/g;
const CLASS_TOKEN = /(班|年级|grade|class)/i;

/**
 * 从文件夹/文件名中提取身份：如「七年级1班-05-张三」「05 张三」「张三_2023005」「李四」「12」。
 * 只有纯数字（整个名字就是学号）或带姓名时才返回身份；「scan_001」「IMG_1234」这类不返回，避免把扫描序号当学号。
 */
export function identityFromLabel(label: string): PaperIdentity | null {
    const text = label.normalize("NFKC").trim();
    if (!text) return null;
    if (/^\d{1,20}$/.test(text)) return { studentNo: text };

    const tokens = text.split(/[\s_\-—–.,，、。·()（）[\]【】#+]+/).filter(Boolean);
    let className: string | null = null;
    let studentNo: string | null = null;
    const nameParts: string[] = [];
    for (const raw of tokens) {
        if (CLASS_TOKEN.test(raw) && /\d|[一二三四五六七八九十初高]/.test(raw)) {
            className = className ?? raw;
            continue;
        }
        if (/^\d{1,20}$/.test(raw)) {
            studentNo = studentNo ?? raw;
            continue;
        }
        // 「05张三」「张三05」这种连写
        const mixed = raw.match(/^(\d{1,20})(\D+)$/) || raw.match(/^(\D+?)(\d{1,20})$/);
        let word = raw;
        if (mixed) {
            const [num, rest] = /^\d/.test(raw) ? [mixed[1], mixed[2]] : [mixed[2], mixed[1]];
            studentNo = studentNo ?? num;
            word = rest;
        }
        const cleaned = word.replace(CJK_NOISE, "").trim();
        if (!cleaned) continue;
        if (/^[a-z]+$/i.test(cleaned) && NOISE_WORDS.has(cleaned.toLowerCase())) continue;
        if (/\d/.test(cleaned)) continue;
        nameParts.push(cleaned);
    }
    const name = nameParts.join(/[\u4e00-\u9fff]/.test(nameParts.join("")) ? "" : " ").trim();
    if (!name) return null;
    return { className, studentNo, name };
}

export type MatchSource = "auto" | "none";

export interface PaperMatch {
    studentId: string | null;
    identity: PaperIdentity | null;
    source: MatchSource;
    /** 已有答卷的学生，导入后会进入待确认 */
    alreadySubmitted: boolean;
}

/**
 * 用名字匹配花名册：只采纳高置信度的唯一匹配；同一批里多份指向同一学生时，只保留第一份，其余改为未匹配。
 */
export function matchImportPapers(labels: string[], roster: RosterStudent[], submittedIds: Set<string> = new Set()): PaperMatch[] {
    const used = new Set<string>();
    return labels.map((label) => {
        const identity = identityFromLabel(label);
        if (!identity) return { studentId: null, identity: null, source: "none", alreadySubmitted: false };
        const result = matchStudent(identity, roster);
        if (result.status !== "matched" || !result.studentId || used.has(result.studentId)) {
            return { studentId: null, identity, source: "none", alreadySubmitted: false };
        }
        used.add(result.studentId);
        return { studentId: result.studentId, identity, source: "auto", alreadySubmitted: submittedIds.has(result.studentId) };
    });
}

/** 幂等键：同一任务、同一组原文件（路径+大小+修改时间）始终得到同一个键，重试或重复导入不会重复建卷 */
export async function computeImportKey(taskId: string, paper: Pick<ImportPaper<unknown>, "pages">): Promise<string> {
    const material = [taskId, ...paper.pages.map((page) => `${segments(page.path).join("/")}\u0000${page.size}\u0000${page.lastModified}`)].join("\u0001");
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 有并发上限的队列；单个任务抛错不影响其他任务 */
export async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
    let next = 0;
    const size = Math.max(1, Math.min(limit, items.length));
    const lanes = Array.from({ length: size }, async () => {
        while (next < items.length) {
            const index = next++;
            try {
                await worker(items[index], index);
            } catch {
                // 由 worker 自行记录失败
            }
        }
    });
    await Promise.all(lanes);
}

/** 从 <input webkitdirectory> 或多选 input 的 FileList 收集 */
export function sourcesFromFileList(files: ArrayLike<File>): ImportSourceFile[] {
    return Array.from(files).map((file) => ({
        file,
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        size: file.size,
        lastModified: file.lastModified,
    }));
}

async function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    // readEntries 每次最多返回约 100 个，需要反复读到空
    for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) return all;
        all.push(...batch);
    }
}

async function walkEntry(entry: FileSystemEntry, out: ImportSourceFile[], limit: number): Promise<void> {
    if (out.length >= limit) return;
    if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, path: entry.fullPath.replace(/^\//, "") || file.name, size: file.size, lastModified: file.lastModified });
    } else if (entry.isDirectory) {
        // 隐藏/系统目录不展开（省得读入 .git 之类的大量文件），只占一条记录以便在忽略清单里列出
        if (entry.name.startsWith(".") || entry.name === "__MACOSX") {
            out.push({ file: new File([], entry.name), path: entry.fullPath.replace(/^\//, "") || entry.name, size: 0, lastModified: 0 });
            return;
        }
        for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await walkEntry(child, out, limit);
    }
}

/** 从拖放数据收集文件（支持拖入文件夹）；不支持目录条目的浏览器退回到普通文件列表 */
export async function sourcesFromDataTransfer(data: DataTransfer, limit = 2000): Promise<ImportSourceFile[]> {
    const items = Array.from(data.items || []).filter((item) => item.kind === "file");
    const entries = items
        .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
        .filter((entry): entry is FileSystemEntry => !!entry);
    if (entries.length === 0) return sourcesFromFileList(data.files);
    const out: ImportSourceFile[] = [];
    for (const entry of entries) await walkEntry(entry, out, limit);
    return out;
}

/**
 * 预先读出所有可导入 PDF 的页数（加密/损坏记为问题），供分组计算页数与上限；
 * counter 由调用方注入（浏览器里是 pdf.js），便于测试。
 */
export async function readPdfInfo<F>(
    files: ImportSourceFile<F>[],
    counter: (source: ImportSourceFile<F>) => Promise<number>,
    classify: (error: unknown) => PdfProblem,
    options: { concurrency?: number; maxFileBytes?: number; maxPdfBytes?: number } = {},
): Promise<PdfInfo> {
    const info: PdfInfo = new Map();
    const pdfs = files.filter((source) => isPdfPath(source.path) && !classifyFile(source.path, source.size, options.maxFileBytes, options.maxPdfBytes));
    await runWithConcurrency(pdfs, options.concurrency ?? 2, async (source) => {
        try {
            info.set(normalizeImportPath(source.path), await counter(source));
        } catch (error) {
            info.set(normalizeImportPath(source.path), classify(error));
        }
    });
    return info;
}
