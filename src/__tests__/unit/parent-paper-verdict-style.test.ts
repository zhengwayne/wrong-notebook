import { describe, expect, it } from "vitest";
import { OVERLAY_COLORS } from "@/lib/parent-paper-annotate";
import {
    NEEDS_CONFIRM_CHIP,
    VERDICT_MARK,
    VERDICT_ON_FILL,
    verdictButtonClass,
    verdictChipClass,
} from "@/lib/parent-paper-verdict-style";

function srgbChannel(value: number): number {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
    const raw = hex.replace("#", "");
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrast(a: string, b: string): number {
    const left = luminance(a);
    const right = luminance(b);
    return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

describe("parent paper verdict styles", () => {
    it("reuses the overlay mark colors for selected buttons and chips", () => {
        expect(VERDICT_MARK.correct).toBe("#3f8f76");
        expect(VERDICT_MARK.wrong).toBe("#c45c6a");
        expect(VERDICT_MARK.partial).toBe("#c4923a");
        expect(OVERLAY_COLORS.correct.stroke).toBe(VERDICT_MARK.correct);
        expect(OVERLAY_COLORS.wrong.stroke).toBe(VERDICT_MARK.wrong);
        expect(OVERLAY_COLORS.partial.stroke).toBe(VERDICT_MARK.partial);

        expect(verdictButtonClass("correct", true)).toContain("bg-[#3f8f76]");
        expect(verdictButtonClass("wrong", true)).toContain("bg-[#c45c6a]");
        expect(verdictButtonClass("partial", true)).toContain("bg-[#c4923a]");
        expect(verdictButtonClass("correct", true)).toContain("text-[#111111]");
        expect(verdictButtonClass("wrong", false)).toContain("text-[#9a4450]");
        expect(verdictButtonClass("partial", false)).toContain("border-[#c4923a]");
        expect(verdictButtonClass("correct", false)).not.toContain("bg-[#3f8f76]");

        expect(verdictChipClass("correct")).toContain("bg-[#edf6f2]");
        expect(verdictChipClass("wrong")).toContain("border-[#c45c6a]");
        expect(verdictChipClass("partial")).toContain("text-[#8a6630]");
        expect(NEEDS_CONFIRM_CHIP).toContain("bg-[#f5f3ff]");
    });

    it("keeps selected fill and dark text at WCAG AA contrast", () => {
        for (const fill of Object.values(VERDICT_MARK)) {
            expect(contrast(fill, VERDICT_ON_FILL)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast("#2f6d5b", "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#9a4450", "#ffffff")).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#8a6630", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    });
});
