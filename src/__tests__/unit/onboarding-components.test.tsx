import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineHint } from "@/components/onboarding/inline-hint";
import { NextStepHost } from "@/components/onboarding/next-step-host";
import { OnboardingCard } from "@/components/onboarding/onboarding-card";
import { OnboardingStrip } from "@/components/onboarding/onboarding-strip";
import { apiClient } from "@/lib/api-client";
import type { OnboardingStatus, OnboardingStep } from "@/lib/onboarding";
import { reportOnboardingStep } from "@/lib/onboarding-client";
import { translations } from "@/lib/translations";

vi.mock("@/contexts/LanguageContext", () => ({
    useLanguage: () => ({ t: translations.zh, language: "zh" }),
}));

vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

vi.mock("@/lib/api-client", () => ({
    apiClient: { get: vi.fn(), post: vi.fn() },
}));

function teacherStatus(done: boolean[], extra: Partial<OnboardingStatus> = {}): OnboardingStatus {
    const keys = ["class", "task", "collect", "confirm"] as const;
    const steps: OnboardingStep[] = keys.map((key, i): OnboardingStep => ({
        key,
        done: done[i] ?? false,
        meta: key === "class" ? { classId: "c-1", className: "初二1班", students: 30 } : key === "task" ? { taskId: "t-1", title: "期中" } : { count: 2, taskId: done[1] ? "t-1" : null },
    }));
    const doneCount = steps.filter((s) => s.done).length;
    return {
        persona: "teacher",
        steps,
        doneCount,
        total: 4,
        completed: doneCount === 4,
        completedAt: doneCount === 4 ? "2026-11-27T00:00:00.000Z" : null,
        dismissedAt: null,
        visible: true,
        current: steps.find((s) => !s.done)?.key ?? null,
        ...extra,
    };
}

describe("onboarding components", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        window.localStorage.clear();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    });

    it("shows the current step with a working link and ticks done steps", async () => {
        vi.mocked(apiClient.get).mockResolvedValue(teacherStatus([true, false]));
        await act(async () => root.render(<OnboardingCard persona="teacher" />));
        expect(host.textContent).toContain("四步开始改卷");
        expect(host.textContent).toContain("1/4");
        expect(host.textContent).toContain("初二1班 · 30 人");
        const action = host.querySelector("li[data-step='task'] a");
        expect(action?.textContent).toContain("新建任务");
        expect(action?.getAttribute("href")).toBe("/grading?new=1");
        expect(host.querySelectorAll("li[data-done='1']")).toHaveLength(1);
    });

    it("collapses through the API and hides", async () => {
        vi.mocked(apiClient.get).mockResolvedValue(teacherStatus([]));
        vi.mocked(apiClient.post).mockResolvedValue(teacherStatus([], { visible: false, dismissedAt: "2026-11-27T00:00:00.000Z" }));
        await act(async () => root.render(<OnboardingCard persona="teacher" />));
        const collapse = [...host.querySelectorAll("button")].find((b) => b.textContent === "收起");
        await act(async () => collapse?.click());
        expect(apiClient.post).toHaveBeenCalledWith("/api/onboarding", { persona: "teacher", action: "dismiss" });
        expect(host.querySelector("[data-testid='onboarding-card-teacher']")).toBeNull();
    });

    it("shows the finish row once everything is done; the strip hides", async () => {
        vi.mocked(apiClient.get).mockResolvedValue(teacherStatus([true, true, true, true]));
        await act(async () => root.render(<><OnboardingCard persona="teacher" /><OnboardingStrip persona="teacher" /></>));
        expect(host.textContent).toContain("已经上手了");
        expect(host.textContent).toContain("都完成了，去看班级学情");
        expect(host.querySelector("[data-testid='onboarding-strip-teacher']")).toBeNull();
    });

    it("inline hints stay hidden after 知道了", async () => {
        vi.mocked(apiClient.get).mockResolvedValue(teacherStatus([true]));
        await act(async () => root.render(<InlineHint id="t-hint" persona="teacher" step={3}>提示内容</InlineHint>));
        expect(host.textContent).toContain("提示内容");
        const gotIt = [...host.querySelectorAll("button")].find((b) => b.textContent === "知道了");
        await act(async () => gotIt?.click());
        expect(host.textContent).not.toContain("提示内容");
        expect(window.localStorage.getItem("xueji.hint.t-hint")).toBe("1");
    });

    it("pops a next-step prompt only when a step is newly done, once", async () => {
        await act(async () => root.render(<NextStepHost />));
        // 先看到“未完成”，再上报完成
        vi.mocked(apiClient.get).mockResolvedValueOnce(teacherStatus([false]));
        await act(async () => root.render(<><NextStepHost /><OnboardingStrip persona="teacher" /></>));
        vi.mocked(apiClient.get).mockResolvedValue(teacherStatus([true]));
        await act(async () => { await reportOnboardingStep("teacher", "class"); });
        const prompt = host.querySelector("[data-testid='onboarding-next-step']");
        expect(prompt?.textContent).toContain("名册已导入：初二1班 · 30 人");
        expect(prompt?.textContent).toContain("下一步：新建改卷任务");
        expect(prompt?.querySelector("a")?.getAttribute("href")).toBe("/grading?new=1");
    });
});
