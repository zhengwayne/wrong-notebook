import { describe, expect, it } from "vitest";
import {
    ONBOARDING_AUTO_HIDE_MS,
    ONBOARDING_STEPS,
    parseOnboardingState,
    summarizeOnboarding,
    type OnboardingStep,
} from "@/lib/onboarding";

const steps = (done: boolean[]): OnboardingStep[] =>
    ONBOARDING_STEPS.teacher.map((key, i) => ({ key, done: done[i] ?? false }));

describe("parseOnboardingState", () => {
    it("tolerates empty, broken and foreign values", () => {
        expect(parseOnboardingState(undefined)).toEqual({});
        expect(parseOnboardingState("not json")).toEqual({});
        expect(parseOnboardingState("[]")).toEqual({});
        expect(parseOnboardingState(JSON.stringify({ dismissed: { teacher: "2026-01-01T00:00:00.000Z", hacker: "x", parent: 3 } })))
            .toEqual({ dismissed: { teacher: "2026-01-01T00:00:00.000Z" }, completedAt: {} });
    });
});

describe("summarizeOnboarding", () => {
    const now = new Date("2026-11-27T03:00:00.000Z");

    it("points at the first unfinished step", () => {
        const { status, newCompletedAt } = summarizeOnboarding("teacher", steps([true, false, false, false]), {}, now);
        expect(status.current).toBe("task");
        expect(status.doneCount).toBe(1);
        expect(status.total).toBe(4);
        expect(status.visible).toBe(true);
        expect(status.completed).toBe(false);
        expect(newCompletedAt).toBeNull();
    });

    it("records completion once and keeps the card for 3 days", () => {
        const first = summarizeOnboarding("teacher", steps([true, true, true, true]), {}, now);
        expect(first.newCompletedAt).toBe(now.toISOString());
        expect(first.status.completed).toBe(true);
        expect(first.status.current).toBeNull();
        expect(first.status.visible).toBe(true);

        const state = { completedAt: { teacher: now.toISOString() } };
        const later = summarizeOnboarding("teacher", steps([true, true, true, true]), state, new Date(now.getTime() + ONBOARDING_AUTO_HIDE_MS + 1));
        expect(later.newCompletedAt).toBeNull();
        expect(later.status.visible).toBe(false);
    });

    it("hides while dismissed", () => {
        const { status } = summarizeOnboarding("teacher", steps([]), { dismissed: { teacher: now.toISOString() } }, now);
        expect(status.visible).toBe(false);
        expect(status.dismissedAt).toBe(now.toISOString());
    });
});
