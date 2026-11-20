import { describe, expect, it } from "vitest";
import {
    classifyFile,
    computeImportKey,
    groupImportFiles,
    identityFromLabel,
    matchImportPapers,
    naturalCompare,
    runWithConcurrency,
    type ImportSourceFile,
} from "@/lib/folder-import";
import type { RosterStudent } from "@/lib/student-match";

const src = (path: string, size = 1000, lastModified = 1): ImportSourceFile<string> => ({ file: path, path, size, lastModified });
const MB = 1024 * 1024;

const roster: RosterStudent[] = [
    { id: "s1", name: "张三", studentNo: "01", classId: "c1", className: "七年级1班" },
    { id: "s2", name: "李四", studentNo: "02", classId: "c1", className: "七年级1班" },
    { id: "s3", name: "王小明", studentNo: "2023005", classId: "c1", className: "七年级1班" },
    { id: "s4", name: "Tom Lee", studentNo: null, classId: "c1", className: "七年级1班" },
];

describe("文件夹导入：文件分类", () => {
    it("忽略隐藏、系统、PDF、非图片和超大文件", () => {
        expect(classifyFile("卷子/.DS_Store", 10)).toBe("system");
        expect(classifyFile("卷子/Thumbs.db", 10)).toBe("system");
        expect(classifyFile("__MACOSX/卷子/._a.jpg", 10)).toBe("system");
        expect(classifyFile("卷子/.hidden.jpg", 10)).toBe("hidden");
        expect(classifyFile("卷子/.git/a.png", 10)).toBe("hidden");
        expect(classifyFile("卷子/张三.pdf", 10)).toBe("pdf");
        expect(classifyFile("卷子/说明.txt", 10)).toBe("unsupported");
        expect(classifyFile("卷子/无扩展名", 10)).toBe("unsupported");
        expect(classifyFile("卷子/张三.JPG", 21 * MB)).toBe("too_large");
        expect(classifyFile("卷子/张三.HEIC", 3 * MB)).toBeNull();
        expect(classifyFile("卷子/张三.webp", 20 * MB)).toBeNull();
    });

    it("自然排序：2 在 10 前面", () => {
        expect(["p10.jpg", "p2.jpg", "p1.jpg"].sort(naturalCompare)).toEqual(["p1.jpg", "p2.jpg", "p10.jpg"]);
    });
});

describe("文件夹导入：分组", () => {
    it("剥掉外层文件夹；子文件夹各成一份并按自然序排页；根目录散放图片各成一份", () => {
        const result = groupImportFiles([
            src("期中/张三/第10页.jpg"),
            src("期中/张三/第2页.jpg"),
            src("期中/张三/第1页.jpg"),
            src("期中/李四/scan/b.png"),
            src("期中/李四/a.png"),
            src("期中/王小明.jpg"),
            src("期中/.DS_Store"),
            src("期中/李四/备注.txt"),
            src("期中/赵六.pdf"),
        ]);
        expect(result.papers.map((paper) => [paper.label, paper.pages.map((page) => page.path)])).toEqual([
            ["李四", ["期中/李四/a.png", "期中/李四/scan/b.png"]],
            ["王小明", ["期中/王小明.jpg"]],
            ["张三", ["期中/张三/第1页.jpg", "期中/张三/第2页.jpg", "期中/张三/第10页.jpg"]],
        ]);
        expect(result.ignored).toEqual([
            { path: "期中/.DS_Store", reason: "system" },
            { path: "期中/李四/备注.txt", reason: "unsupported" },
            { path: "期中/赵六.pdf", reason: "pdf" },
        ]);
        expect(result.overflow).toEqual([]);
        expect(result.tooLarge).toBe(false);
    });

    it("多选文件（没有目录）时每个文件一份；拖入多个文件夹时每个文件夹一份", () => {
        expect(groupImportFiles([src("a.jpg"), src("b.jpg")]).papers.map((paper) => paper.label)).toEqual(["a", "b"]);
        const dragged = groupImportFiles([src("张三/1.jpg"), src("张三/2.jpg"), src("李四/1.jpg")]);
        expect(dragged.papers.map((paper) => [paper.label, paper.pages.length])).toEqual([["李四", 1], ["张三", 2]]);
    });

    it("多层单一外层容器都会剥掉；同一层只有散页时各成一份", () => {
        const result = groupImportFiles([src("扫描/2026/七1班/张三/1.jpg"), src("扫描/2026/七1班/李四/1.jpg")]);
        expect(result.papers.map((paper) => paper.label)).toEqual(["李四", "张三"]);
        expect(groupImportFiles([src("卷子/1.jpg"), src("卷子/2.jpg")]).papers).toHaveLength(2);
    });

    it("超过页数上限的份整份标记不可导入；超出份数上限的放进 overflow；统计总大小", () => {
        const many = Array.from({ length: 9 }, (_, i) => src(`卷/张三/${i + 1}.jpg`));
        const result = groupImportFiles([...many, src("卷/李四/1.jpg", 5 * MB)], { maxPages: 8 });
        expect(result.papers.find((paper) => paper.label === "张三")?.tooManyPages).toBe(true);
        expect(result.papers.find((paper) => paper.label === "李四")?.tooManyPages).toBe(false);
        expect(result.totalBytes).toBe(5 * MB);

        const lots = Array.from({ length: 5 }, (_, i) => src(`卷/${i + 1}.jpg`, 2 * MB));
        const capped = groupImportFiles(lots, { maxPapers: 3, maxTotalBytes: 5 * MB });
        expect(capped.papers.map((paper) => paper.label)).toEqual(["1", "2", "3"]);
        expect(capped.overflow.map((paper) => paper.label)).toEqual(["4", "5"]);
        expect(capped.tooLarge).toBe(true);
    });
});

describe("文件夹导入：从名字识别身份", () => {
    it.each([
        ["张三", { className: null, studentNo: null, name: "张三" }],
        ["05 张三", { className: null, studentNo: "05", name: "张三" }],
        ["七年级1班-05-张三", { className: "七年级1班", studentNo: "05", name: "张三" }],
        ["05张三", { className: null, studentNo: "05", name: "张三" }],
        ["张三_扫描件", { className: null, studentNo: null, name: "张三" }],
        ["Tom Lee", { className: null, studentNo: null, name: "Tom Lee" }],
        ["2023005", { studentNo: "2023005" }],
    ])("%s", (label, expected) => {
        expect(identityFromLabel(label)).toEqual(expected);
    });

    it.each(["scan_001", "IMG_1234", "DSC01234", "第1页", "", "Scan 2026-11-20 10.30"])("扫描仪默认名「%s」不当作身份", (label) => {
        expect(identityFromLabel(label)).toBeNull();
    });
});

describe("文件夹导入：匹配名册", () => {
    it("按姓名/学号匹配，扫描序号不匹配；同一学生只分配给第一份；标记已交过", () => {
        const result = matchImportPapers(["张三", "2023005", "scan_001", "张三 第2份", "Tom Lee", "陌生人", "02 李四"], roster, new Set(["s2"]));
        expect(result.map((item) => item.studentId)).toEqual(["s1", "s3", null, null, "s4", null, "s2"]);
        expect(result.map((item) => item.source)).toEqual(["auto", "auto", "none", "none", "auto", "none", "auto"]);
        expect(result[6].alreadySubmitted).toBe(true);
        expect(result[0].alreadySubmitted).toBe(false);
    });

    it("学号与姓名矛盾时不自动分配", () => {
        expect(matchImportPapers(["01 李四"], roster)[0].studentId).toBeNull();
    });
});

describe("文件夹导入：幂等键与并发队列", () => {
    it("同一任务同一组原文件得到同一个键，换任务或换文件就不同", async () => {
        const paper = { pages: [src("卷/张三/1.jpg", 100, 5), src("卷/张三/2.jpg", 200, 6)] };
        const key = await computeImportKey("task-1", paper);
        expect(key).toMatch(/^[a-f0-9]{64}$/);
        expect(await computeImportKey("task-1", { pages: [...paper.pages] })).toBe(key);
        expect(await computeImportKey("task-2", paper)).not.toBe(key);
        expect(await computeImportKey("task-1", { pages: [paper.pages[0], src("卷/张三/2.jpg", 201, 6)] })).not.toBe(key);
    });

    it("同时最多跑 limit 个，单个失败不影响其他", async () => {
        let running = 0;
        let peak = 0;
        const done: number[] = [];
        await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
            running += 1;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running -= 1;
            if (item === 3) throw new Error("boom");
            done.push(item);
        });
        expect(peak).toBe(2);
        expect(done.sort()).toEqual([1, 2, 4, 5, 6]);
    });
});
