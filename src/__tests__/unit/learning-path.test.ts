import { describe, expect, it } from "vitest";
import { BKT, LOW_EVIDENCE_CAP, buildMasteryMap, evidenceHash, masteryScore, retrievability, traceKnowledgeMastery, updateBkt } from "@/lib/learning-path/mastery-model";
import { addPrerequisiteEdge, buildPrerequisiteGraph, orderKnowledgePoints, unmetPrerequisites } from "@/lib/learning-path/prerequisites";
import { planLearningPath, todaySteps } from "@/lib/learning-path/planner";
import { stepFingerprint, type MasteryEvidence, type PreservedStep } from "@/lib/learning-path/types";

const day = (offset: number) => new Date(Date.UTC(2026, 10, 1 + offset, 4, 0, 0));

describe("BKT 与可提取性掌握模型", () => {
    it("答对会提高 P(L)，答错会降低", () => {
        const afterCorrect = updateBkt(0.3, true);
        const afterWrong = updateBkt(0.3, false);
        expect(afterCorrect).toBeGreaterThan(0.3);
        expect(afterWrong).toBeLessThan(0.3);
        expect(afterCorrect).toBeLessThanOrEqual(1);
        expect(afterWrong).toBeGreaterThanOrEqual(0);
    });

    it("证据不足时掌握分不超过低置信度上限", () => {
        const evidence: MasteryEvidence[] = [
            { knowledgePoint: "方程", correct: true, at: day(0), source: "variant_practice" },
        ];
        const state = traceKnowledgeMastery("方程", evidence, { now: day(0), timeZone: "Asia/Taipei" });
        expect(state.evidenceCount).toBe(1);
        expect(state.score).toBeLessThanOrEqual(LOW_EVIDENCE_CAP);
        expect(masteryScore({ pKnown: 0.95, retrievability: 1, evidenceCount: 1 })).toBe(LOW_EVIDENCE_CAP);
        expect(masteryScore({ pKnown: 0.95, retrievability: 1, evidenceCount: 5 })).toBeGreaterThan(LOW_EVIDENCE_CAP);
    });

    it("连续答错后掌握分低于连续答对", () => {
        const wrongs: MasteryEvidence[] = Array.from({ length: 4 }, (_, i) => ({
            knowledgePoint: "函数", correct: false, at: day(i), source: "error" as const,
        }));
        const corrects: MasteryEvidence[] = Array.from({ length: 4 }, (_, i) => ({
            knowledgePoint: "函数", correct: true, at: day(i), source: "variant_practice" as const,
        }));
        const weak = traceKnowledgeMastery("函数", wrongs, { now: day(4), timeZone: "Asia/Taipei" });
        const strong = traceKnowledgeMastery("函数", corrects, { now: day(4), timeZone: "Asia/Taipei" });
        expect(weak.score).toBeLessThan(strong.score);
        expect(strong.pKnown).toBeGreaterThan(BKT.pL0);
    });

    it("间隔越长可提取性越低", () => {
        expect(retrievability(2, 0)).toBeGreaterThan(retrievability(2, 10));
        expect(retrievability(2, 10)).toBeGreaterThan(retrievability(2, 40));
    });

    it("证据哈希对顺序不敏感，内容变化会变", () => {
        const a: MasteryEvidence[] = [
            { knowledgePoint: "A", correct: false, at: day(0), source: "error", itemId: "1" },
            { knowledgePoint: "A", correct: true, at: day(1), source: "review", itemId: "2" },
        ];
        const b = [...a].reverse();
        const c = [...a, { knowledgePoint: "A", correct: false, at: day(2), source: "grading" as const, itemId: "3" }];
        expect(evidenceHash(a)).toBe(evidenceHash(b));
        expect(evidenceHash(a)).not.toBe(evidenceHash(c));
        expect(buildMasteryMap(a, { now: day(2), timeZone: "Asia/Taipei" }).get("A")?.evidenceCount).toBe(2);
    });
});

describe("先修知识点排序", () => {
    it("父节点排在子节点之前，并保留薄弱优先", () => {
        const graph = buildPrerequisiteGraph([
            { name: "整数运算" },
            { name: "方程", parentName: "整数运算" },
            { name: "函数", parentName: "方程" },
        ]);
        const ordered = orderKnowledgePoints(
            ["函数", "方程", "整数运算"],
            graph,
            new Map([["函数", 9], ["方程", 3], ["整数运算", 5]]),
        );
        expect(ordered.indexOf("整数运算")).toBeLessThan(ordered.indexOf("方程"));
        expect(ordered.indexOf("方程")).toBeLessThan(ordered.indexOf("函数"));
    });

    it("成环的边会被拒绝，排序仍能给出全部节点", () => {
        const graph = buildPrerequisiteGraph([
            { name: "A" },
            { name: "B", parentName: "A" },
        ]);
        expect(addPrerequisiteEdge(graph, "B", "A")).toBe(false);
        const ordered = orderKnowledgePoints(["B", "A"], graph);
        expect(ordered).toHaveLength(2);
        expect(ordered[0]).toBe("A");
    });

    it("能列出尚未掌握的先修", () => {
        const graph = buildPrerequisiteGraph([
            { name: "算术" },
            { name: "方程", parentName: "算术" },
        ]);
        const unmet = unmetPrerequisites("方程", graph, new Map([["算术", 0.2], ["方程", 0.1]]), 0.7);
        expect(unmet).toContain("算术");
    });
});

function mastery(point: string, score: number) {
    return {
        knowledgePoint: point,
        pKnown: score,
        retrievability: 1,
        stabilityDays: 2,
        evidenceCount: 4,
        lastCorrect: false as boolean | null,
        lastObservedAt: day(0),
        dueAt: day(1),
        score,
    };
}

describe("学习路径规划与锁定保留", () => {
    const baseInput = {
        weaknesses: [
            { knowledgePoint: "整数运算", score: 4, unmasteredCount: 1, representativeItemIds: ["item-arith"] },
            { knowledgePoint: "方程", score: 6, unmasteredCount: 2, representativeItemIds: ["item-eq"] },
        ],
        mastery: new Map([
            ["整数运算", mastery("整数运算", 0.3)],
            ["方程", mastery("方程", 0.25)],
        ]),
        dueItemIds: ["item-due"],
        itemMeta: new Map([
            ["item-arith", { knowledgePoints: ["整数运算"], analysis: "算理" }],
            ["item-eq", { knowledgePoints: ["方程"], analysis: "移项" }],
            ["item-due", { knowledgePoints: ["方程"] }],
        ]),
        orderedPoints: ["整数运算", "方程"],
        preserved: [] as PreservedStep[],
        language: "zh" as const,
        now: day(2),
        maxSteps: 8,
    };

    it("按讲解、变式、间隔复习、检查点生成路径，先修点更靠前", () => {
        const plan = planLearningPath(baseInput);
        const types = plan.steps.map((step) => step.type);
        expect(types).toContain("review_explanation");
        expect(types).toContain("variant_practice");
        expect(types).toContain("spaced_review");
        expect(types[types.length - 1]).toBe("checkpoint");
        const firstExplain = plan.steps.find((step) => step.type === "review_explanation");
        expect(firstExplain?.knowledgePoints).toEqual(["整数运算"]);
        expect(plan.focusPoints[0]).toBe("整数运算");
        expect(firstExplain?.href).toBe("/error-items/item-arith");
    });

    it("重规划时保留锁定步骤与已完成步骤，且不重复同一指纹", () => {
        const first = planLearningPath(baseInput);
        const locked = first.steps.find((step) => step.type === "review_explanation" && step.knowledgePoints[0] === "整数运算")!;
        const completed = first.steps.find((step) => step.type === "spaced_review")!;
        const preserved: PreservedStep[] = [
            { ...locked, locked: true, status: "pending", id: "lock-1" },
            { ...completed, status: "completed", completedAt: day(3), id: "done-1" },
        ];
        const again = planLearningPath({ ...baseInput, preserved, now: day(3) });
        expect(again.steps.some((step) => step.id === "lock-1" && step.locked)).toBe(true);
        expect(again.steps.some((step) => step.id === "done-1" && step.status === "completed")).toBe(true);
        const fingerprints = again.steps.map((step) => step.fingerprint);
        expect(new Set(fingerprints).size).toBe(fingerprints.length);
    });

    it("完成后若该知识点又出现新证据，允许再规划同类型步骤", () => {
        const first = planLearningPath(baseInput);
        const explain = first.steps.find((step) => step.type === "review_explanation" && step.knowledgePoints[0] === "方程")!;
        const preserved: PreservedStep[] = [{
            ...explain,
            id: "old-eq",
            status: "completed",
            completedAt: day(0),
        }];
        const masteryMap = new Map(baseInput.mastery);
        masteryMap.set("方程", { ...mastery("方程", 0.2), lastObservedAt: day(4) });
        const again = planLearningPath({ ...baseInput, preserved, mastery: masteryMap, now: day(5) });
        const equationExplains = again.steps.filter((step) => step.type === "review_explanation" && step.knowledgePoints[0] === "方程");
        expect(equationExplains.some((step) => step.id === "old-eq")).toBe(true);
        expect(equationExplains.length).toBeGreaterThan(1);
    });

    it("今日学习只返回未完成且已到期或未设到期日的步骤", () => {
        const steps: PreservedStep[] = [
            { type: "review_explanation", title: "a", reason: "", knowledgePoints: ["A"], errorItemIds: [], status: "completed", locked: false, fingerprint: "1", dueAt: day(0) },
            { type: "variant_practice", title: "b", reason: "", knowledgePoints: ["A"], errorItemIds: [], status: "pending", locked: false, fingerprint: "2", dueAt: day(0) },
            { type: "checkpoint", title: "c", reason: "", knowledgePoints: ["A"], errorItemIds: [], status: "pending", locked: false, fingerprint: "3", dueAt: day(20) },
        ];
        const today = todaySteps(steps, day(1));
        expect(today.map((step) => step.fingerprint)).toEqual(["2"]);
    });

    it("步骤指纹区分类型与知识点", () => {
        expect(stepFingerprint("review_explanation", ["方程"], ["a"])).not.toBe(stepFingerprint("variant_practice", ["方程"], ["a"]));
        expect(stepFingerprint("review_explanation", ["B", "A"], ["2", "1"])).toBe(stepFingerprint("review_explanation", ["A", "B"], ["1", "2"]));
    });
});
