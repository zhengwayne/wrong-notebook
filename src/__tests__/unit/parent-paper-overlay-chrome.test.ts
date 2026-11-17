import { describe, expect, it } from "vitest";
import {
    OVERLAY_BADGE_CLASS,
    OVERLAY_MARK_CLASS,
    badgeChromeStyle,
    markChromeStyle,
} from "@/lib/parent-paper-overlay-chrome";

describe("parent-paper-overlay-chrome", () => {
    it("徽章贴在框外左侧，错开时只平移、不按缩放缩小", () => {
        const style = badgeChromeStyle({ side: "left", shift: 1 }, { x: 0.2 }, "#3f8f76");
        expect(style.right).toBe("100%");
        expect(style.top).toBe(0);
        expect(style.marginRight).toBe(2);
        expect(style.left).toBeUndefined();
        expect(style.background).toBe("#3f8f76");
        expect(style.transform).toBe("translateY(1.05rem)");
        expect(JSON.stringify(style)).not.toMatch(/scale\(/);
    });

    it("贴近页边的徽章改挂在框上方", () => {
        const style = badgeChromeStyle(undefined, { x: 0.02 }, "#c45c6a");
        expect(style.left).toBe(0);
        expect(style.bottom).toBe("100%");
        expect(style.marginBottom).toBe(2);
        expect(style.right).toBeUndefined();
        expect(style.transform).toBeUndefined();
        expect(JSON.stringify(style)).not.toMatch(/scale\(/);
    });

    it("对错标记样式不含反向缩放，颜色保持描边色", () => {
        const style = markChromeStyle("#c4923a");
        expect(style.color).toBe("#c4923a");
        expect(style.transform).toBeUndefined();
        expect(JSON.stringify(style)).not.toMatch(/scale\(/);
    });

    it("100% 与放大后使用同一组可读字号（徽章 11–12px，标记 18–20px）", () => {
        expect(OVERLAY_BADGE_CLASS).toContain("text-[11px]");
        expect(OVERLAY_BADGE_CLASS).toContain("sm:text-[12px]");
        expect(OVERLAY_MARK_CLASS).toContain("text-[18px]");
        expect(OVERLAY_MARK_CLASS).toContain("sm:text-[20px]");
        expect(OVERLAY_MARK_CLASS).toContain("right-0.5");
        expect(OVERLAY_MARK_CLASS).toContain("top-0.5");
    });
});
