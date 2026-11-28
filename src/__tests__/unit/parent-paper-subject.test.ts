import { describe, expect, it } from "vitest";
import { generateExamPaperReadPrompt, parentReviewSubjectGuidance } from "@/lib/ai/prompts";
import { parentPaperSubjectKeySchema } from "@/lib/parent-papers";
import { subjectNameForPaper } from "@/lib/parent-paper-recognize";

describe("parent paper subjectKey schema", () => {
    it("accepts 语文 (chinese) and the rest of the notebook subject list", () => {
        expect(parentPaperSubjectKeySchema.parse("chinese")).toBe("chinese");
        expect(parentPaperSubjectKeySchema.parse("math")).toBe("math");
        expect(parentPaperSubjectKeySchema.parse("english")).toBe("english");
    });

    it("rejects unknown subjects", () => {
        expect(parentPaperSubjectKeySchema.safeParse("法语").success).toBe(false);
        expect(parentPaperSubjectKeySchema.safeParse("french").success).toBe(false);
        expect(parentPaperSubjectKeySchema.safeParse("").success).toBe(false);
    });
});

describe("subjectNameForPaper", () => {
    it("maps a saved chinese subjectKey to 语文 even when the title is the child's name", () => {
        expect(subjectNameForPaper("乐一", null, "chinese")).toBe("语文");
    });

    it("falls back to subjectHint, then title inference, then 其他", () => {
        expect(subjectNameForPaper("乐一", "语文", null)).toBe("语文");
        expect(subjectNameForPaper("数学期中卷", null, null)).toBe("数学");
        expect(subjectNameForPaper("乐一", null, null)).toBe("其他");
    });

    it("prefers the saved subjectKey over a conflicting title", () => {
        expect(subjectNameForPaper("数学期中卷", "英语", "chinese")).toBe("语文");
    });
});

describe("parent_review 语文 prompt branch", () => {
    it("adds Chinese-paper guidance for pinyin, dictation, reading and composition", () => {
        const zh = parentReviewSubjectGuidance("chinese", "zh");
        expect(zh).toContain("语文学科");
        expect(zh).toContain("拼音");
        expect(zh).toContain("字词");
        expect(zh).toContain("古诗文默写");
        expect(zh).toContain("阅读理解");
        expect(zh).toContain("作文");
        expect(zh).toContain("请家长确认");
        expect(zh).toMatch(/partial/);

        const en = parentReviewSubjectGuidance("chinese", "en");
        expect(en).toMatch(/Chinese language|语文/);
        expect(en.toLowerCase()).toContain("pinyin");
        expect(en.toLowerCase()).toContain("composition");
        expect(en).toContain("partial");

        const prompt = generateExamPaperReadPrompt("parent_review", "zh", "chinese");
        expect(prompt).toContain("语文学科");
        expect(prompt).toContain("古诗文默写");

        const plain = generateExamPaperReadPrompt("parent_review", "zh");
        expect(plain).not.toContain("语文学科");
    });
});
