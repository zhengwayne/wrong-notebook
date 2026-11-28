/**
 * 批改标签格式化、匹配 JSON 解析与批改辅助分支单元测试
 */
import { describe, expect, it } from "vitest";
import { identityLabel, studentLabel } from "@/lib/grading-labels";
import { parseCandidates, parseMatchReason } from "@/lib/grading-match-json";
import { buildScoresCsv, matchStudentByName, parseJsonStringArray, summarizeTask } from "@/lib/grading";

describe("grading-labels", () => {
    it("studentLabel 在显隐班级及缺学号下正确拼接", () => {
        expect(studentLabel({ id: "s1", name: "张三", className: "初一(1)班", studentNo: "01" })).toBe("初一(1)班 · 01 · 张三");
        expect(studentLabel({ id: "s1", name: "张三", className: "初一(1)班", studentNo: null }, false)).toBe("张三");
    });

    it("identityLabel 处理 null、空字段与多字段裁剪", () => {
        expect(identityLabel(null)).toBe("");
        expect(identityLabel(undefined)).toBe("");
        expect(identityLabel({ className: " 1班 ", studentNo: " ", name: " 李四 " })).toBe("1班 · 李四");
    });
});

describe("grading-match-json", () => {
    it("安全解析匹配原因与候选学生 JSON，畸形数据回退 null 或空数组", () => {
        expect(parseMatchReason(null)).toBeNull();
        expect(parseMatchReason("{bad-json")).toBeNull();
        expect(parseMatchReason(JSON.stringify({ wrongField: 1 }))).toBeNull();
        expect(parseMatchReason(JSON.stringify({ code: "exact_student_no", studentNoUnmatched: true }))).toEqual({
            code: "exact_student_no",
            studentNoUnmatched: true,
        });

        expect(parseCandidates(undefined)).toEqual([]);
        expect(parseCandidates("not-json")).toEqual([]);
        expect(parseCandidates(JSON.stringify([{ studentId: 123 }]))).toEqual([]);
        expect(
            parseCandidates(JSON.stringify([{ studentId: "stu-1", confidence: 0.9, reason: "exact" }])),
        ).toEqual([{ studentId: "stu-1", confidence: 0.9, reason: "exact" }]);
    });
});

describe("grading.ts 补充边界分支", () => {
    it("matchStudentByName 处理同名冲突与模糊唯一匹配", () => {
        const roster = [
            { id: "1", name: "王小明" },
            { id: "2", name: "王小明" },
            { id: "3", name: "李雷" },
        ];
        expect(matchStudentByName(" ", roster)).toBeNull();
        expect(matchStudentByName("王小明", roster)).toBeNull();
        expect(matchStudentByName("李雷（高一）", roster)).toBe("3");
    });

    it("summarizeTask 与 buildScoresCsv 覆盖空结果、公式转义与逗号引号转义", () => {
        const summary = summarizeTask({
            questions: [
                { id: "q1", order: 1, number: "1", type: "objective", maxScore: 5, answer: "A", knowledgePoints: ["方程"] },
            ],
            submissions: [
                { id: "sub1", studentName: "=SUM(A1)", status: "graded", totalScore: null, results: [{ keyQuestionId: "q1", verdict: "wrong", score: 0 }] },
                { id: "sub2", studentName: null, status: "pending", totalScore: null, results: [] },
            ],
        });
        expect(summary.gradedCount).toBe(1);
        expect(summary.students[1].score).toBeNull();
        expect(summary.weakPoints[0].name).toBe("方程");

        const csv = buildScoresCsv(
            {
                questions: [{ id: "q1", order: 1, number: "1", type: "objective", maxScore: 5, answer: "A" }],
                submissions: [
                    { id: "sub1", studentName: '=cmd|"A"', status: "graded", totalScore: 5, results: [{ keyQuestionId: "q1", verdict: "correct", score: 5 }] },
                    { id: "sub2", studentName: "王,二", status: "pending", totalScore: null, results: [] },
                ],
            },
            { name: "姓名", total: "总分" },
        );
        expect(csv).toContain("\"'=cmd|\"\"A\"\"\"");
        expect(csv).toContain("\"王,二\"");
    });

    it("parseJsonStringArray 过滤非字符串与坏 JSON", () => {
        expect(parseJsonStringArray(null)).toEqual([]);
        expect(parseJsonStringArray("{bad")).toEqual([]);
        expect(parseJsonStringArray(JSON.stringify(["ok", 123, true]))).toEqual(["ok"]);
    });
});
