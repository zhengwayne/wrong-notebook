import { describe, expect, it } from "vitest";
import { parseExamPaperByMode } from "@/lib/ai/exam-paper-read";
import {
    applyAnswerKeyToReview,
    effectiveVerdict,
    isLowConfidence,
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
