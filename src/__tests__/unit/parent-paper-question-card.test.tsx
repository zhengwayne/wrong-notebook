/**
 * 核对页题目卡片：只有「在照片中查看」会跳到照片，点击正文、判定按钮或勾选框不会滚动。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParentPaperQuestionCard, type ParentPaperQuestionCardCopy } from "@/components/parent/parent-paper-question-card";
import type { ParentPaperQuestionView } from "@/lib/parent-papers";

vi.mock("@/components/markdown-renderer", () => ({
    MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="question-body">{content}</div>,
}));

const copy: ParentPaperQuestionCardCopy = {
    questionN: "第{number}题",
    needsConfirm: "需确认",
    confidence: "把握 {value}",
    locateOnPhoto: "在照片中查看",
    studentAnswer: "学生作答",
    correctAnswer: "正确答案",
    errorCause: "错因",
    knowledgePoints: "知识点",
    override: "判定",
    verdictCorrect: "正确",
    verdictPartial: "部分正确",
    verdictWrong: "错误",
    selectForImport: "加入错题本",
};

function question(overrides: Partial<ParentPaperQuestionView> = {}): ParentPaperQuestionView {
    return {
        id: "q1",
        position: 1,
        number: "六、1",
        type: "subjective",
        questionText: "应用题正文，点这里不应跳到照片",
        studentAnswer: "学生写的答案",
        correctAnswer: "标准答案",
        verdict: "wrong",
        overrideVerdict: null,
        effectiveVerdict: "wrong",
        confidence: 0.97,
        errorCause: "计算出错",
        knowledgePoints: ["应用题"],
        bbox: { pageIndex: 0, x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        subjectHint: "math",
        importedErrorItemId: null,
        selected: true,
        ...overrides,
    };
}

let root: Root;
let host: HTMLDivElement;
const onLocate = vi.fn();
const onPatch = vi.fn();

async function renderCard(overrides: Partial<ParentPaperQuestionView> = {}) {
    await act(async () => {
        root.render(
            <ul>
                <ParentPaperQuestionCard
                    question={question(overrides)}
                    copy={copy}
                    selected={false}
                    canEdit={true}
                    busy={false}
                    onLocate={onLocate}
                    onPatch={onPatch}
                />
            </ul>,
        );
    });
}

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onLocate.mockReset();
    onPatch.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await renderCard();
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

describe("ParentPaperQuestionCard", () => {
    it("卡片容器没有 onClick，点击正文不会跳到照片", async () => {
        const card = host.querySelector('[data-testid="parent-paper-question-card"]') as HTMLElement;
        expect(card).toBeTruthy();
        expect(card.onclick).toBeNull();

        await act(async () => {
            host.querySelector('[data-testid="question-body"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onLocate).not.toHaveBeenCalled();
        expect(onPatch).not.toHaveBeenCalled();
    });

    it("只有「在照片中查看」会定位照片", async () => {
        const button = host.querySelector("button") as HTMLButtonElement;
        expect(button.textContent).toContain("在照片中查看");
        await act(async () => { button.click(); });
        expect(onLocate).toHaveBeenCalledTimes(1);
        expect(onLocate).toHaveBeenCalledWith("q1");
        expect(onPatch).not.toHaveBeenCalled();
    });

    it("没有题框时不渲染定位按钮", async () => {
        await renderCard({ bbox: null });
        const labels = [...host.querySelectorAll("button")].map((el) => el.textContent);
        expect(labels).not.toContain("在照片中查看");
        expect(onLocate).not.toHaveBeenCalled();
    });

    it("判定按钮和错题本勾选不会跳到照片", async () => {
        const wrong = [...host.querySelectorAll("button")].find((el) => el.textContent === "错误")!;
        await act(async () => { wrong.click(); });
        expect(onPatch).toHaveBeenCalledWith("q1", { overrideVerdict: "wrong" });
        expect(onLocate).not.toHaveBeenCalled();

        onPatch.mockReset();
        const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(checkbox).toBeTruthy();
        expect(checkbox.checked).toBe(true);
        await act(async () => { checkbox.click(); });
        expect(onPatch).toHaveBeenCalledWith("q1", { selected: false });
        expect(onLocate).not.toHaveBeenCalled();
    });
});
