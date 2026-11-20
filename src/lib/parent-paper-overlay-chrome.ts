import type { CSSProperties } from "react";

/** 题号徽章：各缩放级别保持与 100% 相同的屏上字号 */
export const OVERLAY_BADGE_CLASS =
    "absolute z-[3] whitespace-nowrap rounded-sm px-1 py-px text-center text-[11px] font-semibold leading-[14px] text-white sm:px-1.5 sm:text-[12px]";

/** 对错标记：各缩放级别保持与 100% 相同的屏上大小（约 18–20px） */
export const OVERLAY_MARK_CLASS =
    "absolute right-0.5 top-0.5 text-[18px] font-bold leading-none sm:text-[20px]";

/**
 * 题号徽章贴在框外左上（贴近页边时改到框上方）。
 * 缩放是改容器宽高而不是 CSS scale，字号本身已是固定屏上像素，
 * 不能再按 1/zoom 反向缩放，否则放大后会缩成小点。
 */
export function badgeChromeStyle(
    placement: { side: "left" | "above"; shift: number } | undefined,
    box: { x: number },
    background: string,
): CSSProperties {
    const side = placement?.side ?? (box.x >= 0.07 ? "left" : "above");
    const shift = placement?.shift ?? 0;
    const transform = side === "left"
        ? (shift ? `translateY(${shift * 1.05}rem)` : undefined)
        : (shift ? `translateX(${shift * 1.15}rem)` : undefined);
    return {
        background,
        transform,
        ...(side === "left"
            ? { right: "100%", top: 0, marginRight: 2 }
            : { left: 0, bottom: "100%", marginBottom: 2 }),
    };
}

/** 对错标记固定在框内右上角，不随缩放反向缩小。 */
export function markChromeStyle(color: string): CSSProperties {
    return {
        color,
        textShadow: "0 0 2px #fff, 0 0 2px #fff",
    };
}
