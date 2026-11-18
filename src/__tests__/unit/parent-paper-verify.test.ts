import { describe, expect, it, vi } from "vitest";
import type { ParentReviewQuestion } from "@/lib/parent-paper-review";
import { isLowConfidence } from "@/lib/parent-paper-review";
import {
    applyIndependentCheck,
    localVerifyMath,
    looksLikeMath,
    answersConfidentlyDiffer,
    evaluateArithmeticExpression,
    extractFinalMathValue,
    extractQuestionMath,
    isNonMathSubject,
    normalizeMathText,
    shouldLocalVerifyMath,
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

    it("skips the local math verifier for 语文 papers so dictation is not false-flagged", async () => {
        expect(isNonMathSubject("chinese")).toBe(true);
        expect(isNonMathSubject("语文")).toBe(true);
        expect(isNonMathSubject("math")).toBe(false);

        const dictation = question({
            number: "3",
            type: "objective",
            questionText: "计算加点字的读音：行",
            studentAnswer: "xíng",
            correctAnswer: "xíng",
            verdict: "correct",
            subjectHint: "语文",
            confidence: 0.9,
        });
        // 题干含「计算」时 looksLikeMath 会为真，但不能因此走本地算式核验
        expect(looksLikeMath(dictation.questionText)).toBe(true);
        expect(shouldLocalVerifyMath(dictation, "chinese")).toBe(false);
        expect(shouldVerifyQuestion(dictation, "chinese")).toBe(false);

        const aiVerify = vi.fn(async () => ({
            verdict: "wrong" as const,
            correctAnswer: "0",
            source: "ai" as const,
        }));
        const [checked] = await verifyParentPaperQuestions([dictation], { subject: "chinese", aiVerify });
        expect(aiVerify).not.toHaveBeenCalled();
        expect(checked).toEqual(dictation);
    });

    it("does not locally recompute a 语文 wrong item that happens to contain numbers", async () => {
        const item = question({
            number: "2",
            type: "objective",
            questionText: "默写《观沧海》：日月之行，若出其中；____。",
            studentAnswer: "星汉灿烂若出其里",
            correctAnswer: "星汉灿烂，若出其里。",
            verdict: "wrong",
            confidence: 0.88,
        });
        expect(shouldLocalVerifyMath(item, "chinese")).toBe(false);
        const aiVerify = vi.fn(async () => ({
            verdict: "wrong" as const,
            correctAnswer: item.correctAnswer,
            source: "ai" as const,
        }));
        await verifyParentPaperQuestions([item], { subject: "chinese", aiVerify });
        expect(aiVerify).toHaveBeenCalledTimes(1);
    });
});

describe("real 递等式 paper strings", () => {
    const paper = {
        "一、1": question({
            number: "一、1",
            questionText: "递等式计算（能巧则巧）：$1856 - 258 + 242$",
            studentAnswer: "$=1598+242=1840$",
            correctAnswer: "$1840$",
            verdict: "correct",
        }),
        "一、2": question({
            number: "一、2",
            questionText: "递等式计算（能巧则巧）：$2310 \\div [235 - 160 \\div (21 + 19)]$",
            studentAnswer: "$=2310\\div[235-160\\div 40]=2310\\div[235-4]=2310\\div 231=10$",
            correctAnswer: "$10$",
            verdict: "correct",
        }),
        "一、3": question({
            number: "一、3",
            questionText: "递等式计算（能巧则巧）：$41 \\times 25$",
            studentAnswer: "$=(40+1)\\times 25=(25\\times 40)+(1\\times 25)=1000+25=1025$",
            correctAnswer: "$1025$",
            verdict: "correct",
        }),
        "一、4": question({
            number: "一、4",
            questionText: "递等式计算（能巧则巧）：$199 \\times 99 + 199$",
            studentAnswer: "$=199\\times 99+199\\times 1=(1+99)\\times 199=100\\times 199=19900$",
            correctAnswer: "$19900$",
            verdict: "correct",
        }),
        "一、5": question({
            number: "一、5",
            questionText: "递等式计算（能巧则巧）：$32 \\times 32 + 32 \\times 69 - 32$",
            studentAnswer: "$=32\\times 32+32\\times 69-32\\times 1=(32+69-1)\\times 32=(101-1)\\times 32=100\\times 32=3200$",
            correctAnswer: "$3200$",
            verdict: "correct",
        }),
        "二(1)": question({
            number: "二(1)",
            questionText: "列式计算：$30$ 除 $159$ 与 $441$ 的和，商是几？",
            studentAnswer: "$(159+441)\\div 30=600\\div 30=20$",
            correctAnswer: "$(159 + 441) \\div 30 = 20$",
            verdict: "correct",
        }),
        "六、1": question({
            number: "六、1",
            questionText: "王叔叔计划 $50$ 天加工 $1200$ 个零件，实际比计划提前 $10$ 天完成任务，实际每天加工多少个零件？",
            studentAnswer: "$1200\\div 50=24(\\text{个})$，$50\\times 1200=6000(\\text{个})$，$50-10=40(\\text{个})$，$6000\\div 40=50(\\text{个})$。答：实际每天加工 $50$ 个零件",
            correctAnswer: "实际加工天数：50-10=40（天）；实际每天加工：1200÷40=30（个）。答：实际每天加工30个零件。",
            verdict: "wrong",
        }),
        "六、2": question({
            number: "六、2",
            questionText: "某货场运来 $3600$ 千克的煤，计划烧 $40$ 天，如果每天节约 $10$ 千克，这些煤可以炼多少天？",
            studentAnswer: "$3600\\div 40=90(\\text{kg})$，$90-10=80(\\text{kg})$，$3600\\div 80=43(\\text{天})$。答：这些煤可以炼 $43$ 天",
            correctAnswer: "原计划每天烧煤：3600÷40=90（千克）；节约后每天烧煤：90−10=80（千克）；可以烧：3600÷80=45（天）。答：这些煤可以烧45天。",
            verdict: "wrong",
        }),
    };

    it("evaluates the full expression, not the first two terms", () => {
        expect(evaluateArithmeticExpression("1856-258+242")).toBe("1840");
        expect(evaluateArithmeticExpression("2310/(235-160/(21+19))")).toBe("10");
        expect(evaluateArithmeticExpression("41*25")).toBe("1025");
        expect(evaluateArithmeticExpression("199*99+199")).toBe("19900");
        expect(evaluateArithmeticExpression("32*32+32*69-32")).toBe("3200");
        expect(evaluateArithmeticExpression("1856-258+apple")).toBeNull();
        expect(extractQuestionMath(paper["一、1"].questionText)).toBe("1856-258+242");
        expect(extractQuestionMath(paper["一、2"].questionText)).toBe("2310/(235-160/(21+19))");
    });

    it("reads the final value of a 递等式 student answer", () => {
        expect(extractFinalMathValue(paper["一、1"].studentAnswer)).toBe("1840");
        expect(extractFinalMathValue(paper["一、2"].studentAnswer)).toBe("10");
        expect(extractFinalMathValue(paper["一、3"].studentAnswer)).toBe("1025");
        expect(extractFinalMathValue(paper["一、4"].studentAnswer)).toBe("19900");
        expect(extractFinalMathValue(paper["一、5"].studentAnswer)).toBe("3200");
        expect(extractFinalMathValue(paper["二(1)"].studentAnswer)).toBe("20");
        expect(extractFinalMathValue(paper["六、1"].studentAnswer)).toBe("50");
        expect(extractFinalMathValue(paper["六、1"].correctAnswer)).toBe("30");
        expect(extractFinalMathValue(paper["六、2"].studentAnswer)).toBe("43");
        expect(extractFinalMathValue(paper["六、2"].correctAnswer)).toBe("45");
        expect(answersConfidentlyDiffer(paper["六、1"].studentAnswer, paper["六、1"].correctAnswer)).toBe(true);
        expect(answersConfidentlyDiffer(paper["一、3"].studentAnswer, "1025")).toBe(false);
        expect(answersConfidentlyDiffer("画一个圆", "以点 O 为圆心画圆")).toBe(false);
    });

    it("agrees with correct 递等式 work and does not flag it", async () => {
        const aiVerify = vi.fn();
        const items = ["一、1", "一、2", "一、3", "一、4", "一、5"].map((key) => paper[key as keyof typeof paper]);
        const checked = await verifyParentPaperQuestions(items, { aiVerify });
        expect(aiVerify).not.toHaveBeenCalled();
        for (const item of checked) {
            expect(item.verdict).toBe("correct");
            expect(item.confidence).toBe(0.99);
            expect(isLowConfidence(item.confidence)).toBe(false);
        }
        expect(localVerifyMath(paper["一、1"])).toMatchObject({ source: "local", verdict: "correct", correctAnswer: "1840" });
        expect(localVerifyMath(paper["一、2"])).toMatchObject({ verdict: "correct", correctAnswer: "10" });
        expect(localVerifyMath(paper["一、4"])).toMatchObject({ verdict: "correct", correctAnswer: "19900" });
        expect(localVerifyMath(paper["一、5"])).toMatchObject({ verdict: "correct", correctAnswer: "3200" });
    });

    it("does not parse a word problem as a truncated sum, and does not flag same-verdict wording differences", async () => {
        expect(localVerifyMath(paper["二(1)"])).toBeNull();
        expect(localVerifyMath(paper["六、1"])).toBeNull();
        const original = paper["二(1)"];
        const [checked] = await verifyParentPaperQuestions([original], {
            aiVerify: async () => ({ verdict: "correct", correctAnswer: "20", source: "ai" }),
        });
        expect(checked.confidence).toBe(0.99);
        expect(checked.verdict).toBe("correct");

        const [word] = await verifyParentPaperQuestions([paper["六、1"]], {
            aiVerify: async () => ({ verdict: "wrong", correctAnswer: "30", source: "ai" }),
        });
        expect(word.verdict).toBe("wrong");
        expect(word.confidence).toBe(0.99);
        expect(isLowConfidence(word.confidence)).toBe(false);
    });
});
