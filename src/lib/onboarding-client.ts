"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { withChildParam } from "@/lib/current-child";
import type { OnboardingStatus, OnboardingStepKey } from "@/lib/onboarding";
import type { Persona } from "@/lib/personas";

export type { OnboardingStatus, OnboardingStepKey };

/** 引导状态变化（完成一步、收起、重新打开）后广播，所有引导卡/条随之刷新 */
export const ONBOARDING_REFRESH_EVENT = "xueji:onboarding-refresh";
/** 完成一步后弹出“下一步”提示 */
export const ONBOARDING_NEXT_EVENT = "xueji:onboarding-next";

export interface OnboardingNextDetail {
    persona: Persona;
    step: OnboardingStepKey;
    vars: Record<string, string | number>;
    status: OnboardingStatus;
}

const cache = new Map<Persona, OnboardingStatus>();

export function onboardingUrl(persona: Persona) {
    return `/api/onboarding?persona=${persona}`;
}

export async function fetchOnboarding(persona: Persona): Promise<OnboardingStatus> {
    const status = await apiClient.get<OnboardingStatus>(onboardingUrl(persona), { timeout: 15000 });
    cache.set(persona, status);
    return status;
}

function broadcast(status: OnboardingStatus) {
    cache.set(status.persona, status);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent<OnboardingStatus>(ONBOARDING_REFRESH_EVENT, { detail: status }));
    }
}

export async function setOnboardingVisibility(persona: Persona, action: "dismiss" | "reopen") {
    const status = await apiClient.post<OnboardingStatus>("/api/onboarding", { persona, action });
    broadcast(status);
    return status;
}

const TOAST_SEEN_PREFIX = "xueji.onboarding.toast.";

/**
 * 做完一步操作后调用：重新取进度；若引导还开着、这一步刚完成且没提示过，就弹“下一步”。
 * 传多个步骤时只提示最后一个刚完成的。失败静默——引导只是辅助，不能影响主流程。
 */
export async function reportOnboardingStep(persona: Persona, steps: OnboardingStepKey | OnboardingStepKey[], vars: Record<string, string | number> = {}) {
    const list = Array.isArray(steps) ? steps : [steps];
    try {
        const before = cache.get(persona);
        const pending = list.filter((key) => !before?.steps.find((s) => s.key === key)?.done);
        if (pending.length === 0) return;
        const status = await fetchOnboarding(persona);
        broadcast(status);
        if (!status.visible) return;
        const fresh = pending.filter((key) => status.steps.find((s) => s.key === key)?.done);
        const step = fresh[fresh.length - 1];
        if (!step) return;
        const seenKey = `${TOAST_SEEN_PREFIX}${persona}.${step}`;
        try {
            if (window.localStorage.getItem(seenKey)) return;
            window.localStorage.setItem(seenKey, "1");
        } catch { /* 隐私模式下照常提示 */ }
        window.dispatchEvent(new CustomEvent<OnboardingNextDetail>(ONBOARDING_NEXT_EVENT, { detail: { persona, step, vars, status } }));
    } catch {
        /* ignore */
    }
}

const pendingReports = new Map<Persona, { steps: Set<OnboardingStepKey>; timer: ReturnType<typeof setTimeout> }>();

/** 合并短时间内的多次上报（批量导入时每题都会调用），只取一次进度 */
function queueReport(persona: Persona, steps: OnboardingStepKey[]) {
    const pending = pendingReports.get(persona);
    if (pending) {
        steps.forEach((step) => pending.steps.add(step));
        return;
    }
    const entry = {
        steps: new Set(steps),
        timer: setTimeout(() => {
            pendingReports.delete(persona);
            void reportOnboardingStep(persona, [...entry.steps]);
        }, 600),
    };
    pendingReports.set(persona, entry);
}

/** 存了错题或做完复习后：按是给孩子还是给自己，更新对应身份的引导 */
export function reportLearningProgress(kind: "item" | "review", learnerId?: string | null) {
    if (typeof window === "undefined") return;
    if (kind === "item") {
        if (learnerId) queueReport("parent", ["paper", "confirm"]);
        else queueReport("self", ["capture", "collect"]);
        return;
    }
    queueReport("self", ["review"]);
    queueReport("parent", ["review"]);
}

export function useOnboarding(persona: Persona | null | undefined, enabled = true) {
    const [status, setStatus] = useState<OnboardingStatus | null>(() => (persona ? cache.get(persona) ?? null : null));

    useEffect(() => {
        if (!persona || !enabled) return;
        let alive = true;
        fetchOnboarding(persona).then((s) => { if (alive) setStatus(s); }).catch(() => { /* 引导取不到就不显示 */ });
        const onRefresh = (event: Event) => {
            const detail = (event as CustomEvent<OnboardingStatus>).detail;
            if (detail?.persona === persona) setStatus(detail);
        };
        window.addEventListener(ONBOARDING_REFRESH_EVENT, onRefresh);
        return () => {
            alive = false;
            window.removeEventListener(ONBOARDING_REFRESH_EVENT, onRefresh);
        };
    }, [persona, enabled]);

    const refresh = useCallback(async () => {
        if (!persona) return null;
        const s = await fetchOnboarding(persona);
        broadcast(s);
        return s;
    }, [persona]);

    return { status: persona && status?.persona === persona ? status : null, refresh };
}

/** 每一步按钮去哪：只用进度里带回的 id，不额外请求 */
export function onboardingStepHref(status: OnboardingStatus, key: OnboardingStepKey | "finish"): string {
    const meta = (k: string) => status.steps.find((s) => s.key === k)?.meta ?? {};
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    if (status.persona === "teacher") {
        const taskId = str(meta("collect").taskId) || str(meta("task").taskId);
        switch (key) {
            case "class": return "/grading#roster";
            case "task": return "/grading?new=1";
            case "collect": return taskId ? `/grading/${taskId}?tab=capture` : "/grading";
            case "confirm": return taskId ? `/grading/${taskId}?tab=papers` : "/grading";
            default: return taskId ? `/grading/${taskId}?tab=summary` : "/teacher";
        }
    }
    if (status.persona === "parent") {
        const learnerId = str(meta("child").learnerId);
        switch (key) {
            case "child": return "/parent?manage=1";
            case "paper": return withChildParam("/parent/papers/new", learnerId);
            case "confirm": {
                const paperId = str(meta("confirm").paperId);
                return withChildParam(paperId ? `/parent/papers/${paperId}` : "/parent/papers", learnerId);
            }
            case "review": return withChildParam("/review", learnerId);
            default: return withChildParam("/learn", learnerId);
        }
    }
    switch (key) {
        case "capture":
        case "collect": return "/#capture";
        case "review": return "/review";
        default: return "/learn";
    }
}

/** 简单占位替换 {name} */
export function fillCopy(template: string, vars: Record<string, string | number | null | undefined> = {}) {
    return template.replace(/\{(\w+)\}/g, (_, k: string) => {
        const v = vars[k];
        return v === null || v === undefined ? "" : String(v);
    });
}
