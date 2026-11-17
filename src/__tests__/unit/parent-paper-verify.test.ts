import { describe, expect, it, vi } from "vitest";
import type { ParentReviewQuestion } from "@/lib/parent-paper-review";
import { isLowConfidence } from "@/lib/parent-paper-review";
import {
    applyIndependentCheck,
    localVerifyMath,
    looksLikeMath,
    normalizeMathText,
    shouldVerifyQuestion,
    verifyParentPaperQuestions,
    VERIFY_DISAGREE_CONFIDENCE,
} from "@/lib/parent-paper-verify";

function question(partial: Partial<ParentReviewQuestion> & Pick<ParentReviewQuestion, "number" | "questionText" | "studentAnswer" | "correctAnswer" | "verdict">): ParentReviewQuestion {
    return {
        type: "objective",
        confidence: 0.99,
        errorCause: null,
        knowledgePoints: [],
        subjectHint: "数学",
        bbox: null,
        ...partial,
    };
}

describe("local math verify", () => {
    it("normalizes latex and full-width symbols", () => {
        expect(normalizeMathText("解方程：$x + 2 = 5$")).toContain("x+2=5");
        expect(looksLikeMath("解方程：x + 2 = 5")).toBe(true);
    });

    it("independently solves x+2=5 and marks x=2 as wrong", () => {
        const check = localVerifyMath(question({
            number: "2",
            questionText: "解方程：$x + 2 = 5$",
            studentAnswer: "x = 2",
            correctAnswer: "x = 3",
            verdict: "wrong",
        }));
        expect(check).toMatchObject({ source: "local", verdict: "wrong" });
        expect(check?.correctAnswer.replace(/\s/g, "")).toMatch(/x=3/);
    });

    it("marks x=3 as correct for x+2=5", () => {
        const check = localVerifyMath(question({
            number: "2",
            questionText: "解方程：x + 2 = 5",
            studentAnswer: "x = 3",
            correctAnswer: "x = 3",
            verdict: "correct",
        }));
        expect(check?.verdict).toBe("correct");
    });

    it("solves fill-in arithmetic", () => {
        expect(localVerifyMath(question({
            number: "1",
            questionText: "计算：$1 + 1 = \\underline{\\quad}$",
            studentAnswer: "3",
            correctAnswer: "2",
            verdict: "wrong",
        }))).toMatchObject({ verdict: "wrong", correctAnswer: "2" });
        expect(localVerifyMath(question({
            number: "3",
            questionText: "计算：2 + 2 = ___",
            studentAnswer: "4",
            correctAnswer: "4",
            verdict: "correct",
        }))).toMatchObject({ verdict: "correct", correctAnswer: "4" });
    });

    it("solves 2+x=5 and 2x+3=11", () => {
        expect(localVerifyMath(question({
            number: "4",
            questionText: "解方程：2 + x = 5",
            studentAnswer: "3",
            correctAnswer: "3",
            verdict: "correct",
        }))?.verdict).toBe("correct");
        expect(localVerifyMath(question({
            number: "5",
            questionText: "2x + 3 = 11",
            studentAnswer: "x=4",
            correctAnswer: "4",
            verdict: "correct",
        }))?.verdict).toBe("correct");
    });

    it("returns null for word problems it cannot parse", () => {
        expect(localVerifyMath(question({
            number: "4",
            questionText: "小明有 8 个苹果，吃掉 3 个，还剩多少个？",
            studentAnswer: "8 + 3 = 11",
            correctAnswer: "5",
            verdict: "wrong",
        }))).toBeNull();
    });
});

describe("applyIndependentCheck", () => {
    it("flags and lowers confidence when the model marks x=2 as correct for x+2=5", () => {
        const original = question({
            number: "2",
            questionText: "解方程：x + 2 = 5",
            studentAnswer: "x = 2",
            correctAnswer: "x = 2",
            verdict: "correct",
            confidence: 0.99,
        });
        const checked = applyIndependentCheck(original, localVerifyMath(original));
        expect(checked.verdict).toBe("correct");
        expect(checked.confidence).toBe(VERIFY_DISAGREE_CONFIDENCE);
        expect(isLowConfidence(checked.confidence)).toBe(true);
        expect(checked.correctAnswer.replace(/\s/g, "")).toMatch(/x=3/);
    });

    it("keeps a high-confidence wrong verdict when local solving agrees", () => {
        const original = question({
            number: "2",
            questionText: "解方程：x + 2 = 5",
            studentAnswer: "x = 2",
            correctAnswer: "$x = 3$",
            verdict: "wrong",
            confidence: 0.99,
        });
        const checked = applyIndependentCheck(original, localVerifyMath(original));
        expect(checked.verdict).toBe("wrong");
        expect(checked.confidence).toBe(0.99);
        expect(isLowConfidence(checked.confidence)).toBe(false);
    });

    it("leaves the question unchanged when the check is missing", () => {
        const original = question({
            number: "4",
            questionText: "小明有 8 个苹果，吃掉 3 个，还剩多少个？",
            studentAnswer: "11",
            correctAnswer: "5",
            verdict: "wrong",
            confidence: 0.88,
        });
        expect(applyIndependentCheck(original, null)).toEqual(original);
    });
});

describe("verifyParentPaperQuestions", () => {
    it("uses local solving for the x+2=5 → x=2 case and does not call the text model", async () => {
        const aiVerify = vi.fn();
        const [checked] = await verifyParentPaperQuestions([
            question({
                number: "2",
                questionText: "解方程：$x + 2 = 5$",
                studentAnswer: "x = 2",
                correctAnswer: "x = 2",
                verdict: "correct",
                confidence: 0.99,
            }),
        ], { aiVerify });
        expect(aiVerify).not.toHaveBeenCalled();
        expect(checked.confidence).toBe(VERIFY_DISAGREE_CONFIDENCE);
        expect(checked.verdict).toBe("correct");
        expect(isLowConfidence(checked.confidence)).toBe(true);
    });

    it("asks the text model only when local solving cannot parse the item", async () => {
        const aiVerify = vi.fn(async () => ({
            verdict: "correct" as const,
            correctAnswer: "5",
            source: "ai" as const,
        }));
        const [checked] = await verifyParentPaperQuestions([
            question({
                number: "4",
                questionText: "小明有 8 个苹果，吃掉 3 个，还剩多少个？",
                studentAnswer: "5",
                correctAnswer: "11",
                verdict: "wrong",
                confidence: 0.95,
            }),
        ], { aiVerify });
        expect(aiVerify).toHaveBeenCalledTimes(1);
        expect(checked.confidence).toBe(VERIFY_DISAGREE_CONFIDENCE);
        expect(checked.correctAnswer).toBe("5");
        expect(checked.verdict).toBe("wrong");
    });

    it("degrades gracefully when the text-model check fails", async () => {
        const original = question({
            number: "4",
            questionText: "小明有 8 个苹果，吃掉 3 个，还剩多少个？",
            studentAnswer: "11",
            correctAnswer: "5",
            verdict: "wrong",
            confidence: 0.95,
        });
        const [failed] = await verifyParentPaperQuestions([original], {
            aiVerify: async () => { throw new Error("AI_DOWN"); },
        });
        expect(failed).toEqual(original);
    });

    it("caps concurrent AI checks and skips the rest", async () => {
        const aiVerify = vi.fn(async (item: ParentReviewQuestion) => ({
            verdict: "wrong" as const,
            correctAnswer: item.correctAnswer,
            source: "ai" as const,
        }));
        const questions = Array.from({ length: 5 }, (_, index) => question({
            number: String(index + 1),
            questionText: "小明有 8 个苹果，吃掉 3 个，还剩多少个？",
            studentAnswer: "11",
            correctAnswer: "5",
            verdict: "wrong",
            confidence: 0.9,
        }));
        await verifyParentPaperQuestions(questions, { aiVerify, maxAiChecks: 2, concurrency: 2 });
        expect(aiVerify).toHaveBeenCalledTimes(2);
    });

    it("does not verify a non-math correct subjective item", async () => {
        const aiVerify = vi.fn();
        const original = question({
            number: "9",
            type: "subjective",
            questionText: "写出你的感想",
            studentAnswer: "很好",
            correctAnswer: "开放作答",
            verdict: "correct",
            subjectHint: "语文",
            confidence: 0.8,
        });
        expect(shouldVerifyQuestion(original)).toBe(false);
        const [checked] = await verifyParentPaperQuestions([original], { aiVerify });
        expect(aiVerify).not.toHaveBeenCalled();
        expect(checked).toEqual(original);
    });
});
