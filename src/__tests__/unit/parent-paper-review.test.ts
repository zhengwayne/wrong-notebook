import { describe, expect, it } from "vitest";
import { parseExamPaperByMode } from "@/lib/ai/exam-paper-read";
import {
    applyAnswerKeyToReview,
    BBOX_PAD_X,
    BBOX_PAD_Y,
    effectiveVerdict,
    expandQuestionBBox,
    isLowConfidence,
    normalizeQuestionBBox,
    parseParentPaperReview,
    shouldImportVerdict,
    validateQuestionBBox,
} from "@/lib/parent-paper-review";

const pageCount = 2;

describe("validateQuestionBBox", () => {
    it("keeps already-normalized boxes and clamps overflow", () => {
        expect(validateQuestionBBox({ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.3 }, pageCount)).toEqual({
            pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.3,
        });
        expect(validateQuestionBBox({ pageIndex: 1, x: 0.8, y: 0.8, width: 0.5, height: 0.5 }, pageCount)).toEqual({
            pageIndex: 1, x: 0.8, y: 0.8, width: 0.2, height: 0.2,
        });
    });

    it("accepts 0-100 percentages", () => {
        expect(validateQuestionBBox({ pageIndex: 0, x: 10, y: 20, width: 50, height: 25 }, pageCount)).toEqual({
            pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.25,
        });
    });

    it("drops malformed, pixel, out-of-range and tiny boxes", () => {
        expect(validateQuestionBBox(null, pageCount)).toBeNull();
        expect(validateQuestionBBox({ pageIndex: 0, x: 10, y: 10 }, pageCount)).toBeNull();
        expect(validateQuestionBBox({ pageIndex: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, pageCount)).toBeNull();
        expect(validateQuestionBBox({ pageIndex: -1, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, pageCount)).toBeNull();
        expect(validateQuestionBBox({ pageIndex: 0, x: 12, y: 40, width: 200, height: 80 }, pageCount)).toBeNull();
        expect(validateQuestionBBox({ pageIndex: 0, x: 0.1, y: 0.1, width: 0.001, height: 0.2 }, pageCount)).toBeNull();
        expect(validateQuestionBBox({ pageIndex: 0, x: 0, y: 0, width: 0, height: 0.5 }, pageCount)).toBeNull();
    });
});

describe("parseParentPaperReview", () => {
    it("parses questions and stores only valid bboxes", () => {
        const result = parseParentPaperReview(JSON.stringify({
            questions: [
                {
                    number: "1",
                    type: "objective",
                    questionText: "计算 $1+1$",
                    studentAnswer: "3",
                    correctAnswer: "2",
                    verdict: "wrong",
                    confidence: 0.92,
                    errorCause: "加法算错",
                    knowledgePoints: ["加法"],
                    bbox: { pageIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
                },
                {
                    number: "2",
                    verdict: "correct",
                    confidence: 80,
                    bbox: { pageIndex: 0, x: 10, y: 20, width: 400, height: 80 },
                },
            ],
        }), pageCount);
        expect(result.questions).toHaveLength(2);
        // 解析层只校验，不外扩：外扩统一在识卷流水线里做一次
        expect(result.questions[0].bbox).toEqual({ pageIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.2 });
        expect(result.questions[0].questionText).toBe("计算 $1+1$");
        expect(result.questions[1].confidence).toBe(0.8);
        expect(result.questions[1].bbox).toBeNull();
    });

    it("allows an empty question list", () => {
        expect(parseParentPaperReview('{"questions":[]}', 1).questions).toEqual([]);
        expect(parseParentPaperReview("{}", 1).questions).toEqual([]);
    });

    it("skips items without a question number", () => {
        const result = parseParentPaperReview(JSON.stringify({
            questions: [{ number: "", verdict: "wrong" }, { number: "3", verdict: "partial", studentAnswer: "一半" }],
        }), 1);
        expect(result.questions.map((item) => item.number)).toEqual(["3"]);
        expect(result.questions[0].verdict).toBe("partial");
    });
});

describe("parseExamPaperByMode", () => {
    it("routes parent_review through the review parser", () => {
        const result = parseExamPaperByMode("parent_review", '{"questions":[{"number":"1","verdict":"correct","bbox":{"pageIndex":0,"x":0.1,"y":0.1,"width":0.4,"height":0.2}}]}', 1);
        expect(result.questions).toEqual([]);
        expect(result.reviewQuestions?.[0]).toMatchObject({ number: "1", verdict: "correct" });
        expect(result.reviewQuestions?.[0].bbox).toEqual({ pageIndex: 0, x: 0.1, y: 0.1, width: 0.4, height: 0.2 });
    });
});

describe("applyAnswerKeyToReview", () => {
    it("overrides objective verdicts from the answer key and leaves subjective ones to the model", () => {
        const reviewed = applyAnswerKeyToReview([
            { number: "1", type: "objective", questionText: "", studentAnswer: "B", correctAnswer: "A", verdict: "correct", confidence: 0.4, errorCause: null, knowledgePoints: [], subjectHint: null, bbox: null },
            { number: "2", type: "subjective", questionText: "证明", studentAnswer: "步骤不完整", correctAnswer: "完整证明", verdict: "partial", confidence: 0.6, errorCause: "缺步骤", knowledgePoints: [], subjectHint: null, bbox: null },
        ], [
            { number: "1", type: "objective", answer: "C" },
            { number: "2", type: "subjective", answer: "完整证明" },
        ]);
        expect(reviewed[0]).toMatchObject({ verdict: "wrong", correctAnswer: "C", confidence: 0.9 });
        expect(reviewed[1]).toMatchObject({ verdict: "partial", correctAnswer: "完整证明" });
    });
});

describe("verdict helpers", () => {
    it("uses the parent override when present", () => {
        expect(effectiveVerdict("wrong", "correct")).toBe("correct");
        expect(shouldImportVerdict("wrong")).toBe(true);
        expect(shouldImportVerdict("partial")).toBe(true);
        expect(shouldImportVerdict("correct")).toBe(false);
        expect(isLowConfidence(0.69)).toBe(true);
        expect(isLowConfidence(0.7)).toBe(false);
    });
});

describe("expandQuestionBBox", () => {
    it("adds only a small pad and does not stretch a tight box to full width", () => {
        const expanded = expandQuestionBBox({ pageIndex: 0, x: 0.2, y: 0.2, width: 0.3, height: 0.1 });
        expect(expanded.x).toBeLessThan(0.2);
        expect(expanded.y).toBeLessThan(0.2);
        expect(expanded.x + expanded.width).toBeGreaterThan(0.5);
        expect(expanded.width).toBeLessThan(0.4);
        expect(expanded.height).toBeLessThan(0.14);
        expect(expanded.x).toBeGreaterThanOrEqual(0);
        expect(expanded.x + expanded.width).toBeLessThanOrEqual(1);
    });

    it("does not grow a tight left-aligned box across the page", () => {
        const expanded = expandQuestionBBox({ pageIndex: 0, x: 0.06, y: 0.12, width: 0.15, height: 0.08 });
        expect(expanded.width).toBeLessThan(0.22);
        expect(expanded.height).toBeLessThan(0.12);
        expect(expanded.x).toBeLessThanOrEqual(0.06);
        expect(expanded.x + expanded.width).toBeLessThan(0.25);
    });

    it("keeps a tight right-column box in the right column", () => {
        const expanded = expandQuestionBBox({ pageIndex: 1, x: 0.8, y: 0.3, width: 0.14, height: 0.1 });
        expect(expanded.pageIndex).toBe(1);
        expect(expanded.width).toBeLessThan(0.2);
        expect(expanded.x).toBeGreaterThan(0.75);
        expect(expanded.x + expanded.width).toBeLessThanOrEqual(1);
    });

    it("clamps a box near the page edge", () => {
        const expanded = expandQuestionBBox({ pageIndex: 0, x: 0.9, y: 0.92, width: 0.09, height: 0.07 });
        expect(expanded.x + expanded.width).toBeLessThanOrEqual(1);
        expect(expanded.y + expanded.height).toBeLessThanOrEqual(1);
    });
});

describe("normalizeQuestionBBox", () => {
    it("validates then expands, and still drops pixel coordinates", () => {
        const normalized = normalizeQuestionBBox({ pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, 1);
        expect(normalized?.width).toBeGreaterThan(0.2);
        expect(normalizeQuestionBBox({ pageIndex: 0, x: 12, y: 40, width: 300, height: 80 }, 1)).toBeNull();
    });

    it("pads a model box exactly once across parse + normalize", () => {
        const raw = { pageIndex: 0, x: 0.2, y: 0.3, width: 0.4, height: 0.1 };
        const parsed = parseParentPaperReview(JSON.stringify({ questions: [{ number: "1", verdict: "wrong", bbox: raw }] }), 1);
        const stored = normalizeQuestionBBox(parsed.questions[0].bbox, 1);
        expect(stored).toEqual(expandQuestionBBox(raw));
        expect(stored).not.toEqual(expandQuestionBBox(expandQuestionBBox(raw)));
        expect(stored).toEqual({
            pageIndex: 0,
            x: Number((0.2 - BBOX_PAD_X).toFixed(4)),
            y: Number((0.3 - BBOX_PAD_Y).toFixed(4)),
            width: Number((0.4 + BBOX_PAD_X * 2).toFixed(4)),
            height: Number((0.1 + BBOX_PAD_Y * 2).toFixed(4)),
        });
    });

    it("converts 0-100 percentage coordinates in the parser and still pads only once", () => {
        const parsed = parseParentPaperReview(JSON.stringify({
            questions: [{ number: "1", verdict: "wrong", bbox: { pageIndex: 0, x: 20, y: 30, width: 40, height: 10 } }],
        }), 1);
        expect(parsed.questions[0].bbox).toEqual({ pageIndex: 0, x: 0.2, y: 0.3, width: 0.4, height: 0.1 });
        expect(normalizeQuestionBBox(parsed.questions[0].bbox, 1)).toEqual(expandQuestionBBox(parsed.questions[0].bbox!));
    });
});
