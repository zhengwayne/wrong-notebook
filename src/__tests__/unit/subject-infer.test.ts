import { describe, expect, it } from "vitest";
import { dominantSubject, inferSubjectFromContent } from "@/lib/subject-infer";
import { paperDominantSubject, subjectNameForPaper } from "@/lib/parent-paper-recognize";

describe("inferSubjectFromContent", () => {
    it.each([
        ["二、给加点字选择正确读音，打“√” **奔**跑（bēn  bèn）", "chinese"],
        ["② 从这些动作，你体会到人物怎样的心情？请对这句话作批注：", "chinese"],
        ["③ 仿照例句，运用动作描写，写出人物着急或开心时的表现。", "chinese"],
        ["用“﹏﹏”画出写老公鹅动作的词语，从这些词语中可以体会到老公鹅（怎样的特点）。", "chinese"],
        ["（2）$75$ 的 $4$ 倍减去 $36$ 与 $97$ 的和，差是几？", "math"],
        ["计算：$36 + 47 =$", "math"],
        ["Read and choose. What colour is the apple? It is red.", "english"],
    ])("%s → %s", (text, subject) => {
        expect(inferSubjectFromContent(text)).toBe(subject);
    });

    it("判断不出时返回 null", () => {
        expect(inferSubjectFromContent("")).toBeNull();
        expect(inferSubjectFromContent("第 1 题")).toBeNull();
    });

    it("取出现最多的学科", () => {
        expect(dominantSubject(["chinese", null, "math", "chinese"])).toBe("chinese");
        expect(dominantSubject([null])).toBeNull();
    });
});

describe("没选学科的卷子归本", () => {
    it("按题目内容推断，推断不出按整卷主学科，再不行才是「其他」", () => {
        expect(subjectNameForPaper("水儿 11月26日", null, null, { content: "$75$ 的 $4$ 倍减去 $36$ 与 $97$ 的和，差是几？" })).toBe("数学");
        expect(subjectNameForPaper("水儿", "其他", null, { content: "请对这句话作批注：" })).toBe("语文");
        expect(subjectNameForPaper("水儿", null, null, { content: "第 5 题", paperFallback: "chinese" })).toBe("语文");
        expect(subjectNameForPaper("水儿", null, null, { content: "第 5 题" })).toBe("其他");
        // 选了学科、识别给了学科时仍以它们为准
        expect(subjectNameForPaper("水儿", "英语", null, { content: "请对这句话作批注：" })).toBe("英语");
        expect(subjectNameForPaper("水儿", null, "math", { content: "请对这句话作批注：" })).toBe("数学");
        expect(paperDominantSubject([
            { questionText: "给加点字选择正确读音 bēn bèn" },
            { questionText: "请对这句话作批注：" },
            { questionText: "填写表格" },
        ])).toBe("chinese");
    });
});
