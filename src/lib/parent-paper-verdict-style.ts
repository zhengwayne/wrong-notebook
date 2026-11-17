/**
 * 家长试卷判定色：与原图叠层标记同一组纯色，不用渐变。
 * 选中按钮用色块底 + 深色字，对比度达到 WCAG AA（4.5:1）。
 */
import type { ParentReviewVerdict } from "@/lib/parent-paper-review";

export const VERDICT_MARK: Record<ParentReviewVerdict, string> = {
    correct: "#3f8f76",
    wrong: "#c45c6a",
    partial: "#c4923a",
};

/** 选中色块上的文字，保证在三个色底上都达到 AA */
export const VERDICT_ON_FILL = "#111111";

export const VERDICT_STYLE: Record<ParentReviewVerdict, {
    mark: string;
    fill: string;
    fillHover: string;
    onFill: string;
    text: string;
    softFill: string;
    softBorder: string;
    buttonSelected: string;
    buttonIdle: string;
    chip: string;
}> = {
    correct: {
        mark: VERDICT_MARK.correct,
        fill: VERDICT_MARK.correct,
        fillHover: "#35856d",
        onFill: VERDICT_ON_FILL,
        text: "#2f6d5b",
        softFill: "#edf6f2",
        softBorder: "#3f8f76",
        buttonSelected: "border-[#3f8f76] bg-[#3f8f76] text-[#111111] hover:bg-[#35856d] hover:text-[#111111] focus-visible:ring-[#3f8f76]/40",
        buttonIdle: "border-[#3f8f76] bg-card text-[#2f6d5b] hover:bg-[#edf6f2] hover:text-[#2f6d5b] focus-visible:ring-[#3f8f76]/40",
        chip: "border-[#3f8f76] bg-[#edf6f2] text-[#2f6d5b]",
    },
    wrong: {
        mark: VERDICT_MARK.wrong,
        fill: VERDICT_MARK.wrong,
        fillHover: "#b4515e",
        onFill: VERDICT_ON_FILL,
        text: "#9a4450",
        softFill: "#f8eef0",
        softBorder: "#c45c6a",
        buttonSelected: "border-[#c45c6a] bg-[#c45c6a] text-[#111111] hover:bg-[#b4515e] hover:text-[#111111] focus-visible:ring-[#c45c6a]/40",
        buttonIdle: "border-[#c45c6a] bg-card text-[#9a4450] hover:bg-[#f8eef0] hover:text-[#9a4450] focus-visible:ring-[#c45c6a]/40",
        chip: "border-[#c45c6a] bg-[#f8eef0] text-[#9a4450]",
    },
    partial: {
        mark: VERDICT_MARK.partial,
        fill: VERDICT_MARK.partial,
        fillHover: "#b38332",
        onFill: VERDICT_ON_FILL,
        text: "#8a6630",
        softFill: "#f8f1e6",
        softBorder: "#c4923a",
        buttonSelected: "border-[#c4923a] bg-[#c4923a] text-[#111111] hover:bg-[#b38332] hover:text-[#111111] focus-visible:ring-[#c4923a]/40",
        buttonIdle: "border-[#c4923a] bg-card text-[#8a6630] hover:bg-[#f8f1e6] hover:text-[#8a6630] focus-visible:ring-[#c4923a]/40",
        chip: "border-[#c4923a] bg-[#f8f1e6] text-[#8a6630]",
    },
};

export const NEEDS_CONFIRM_CHIP = "border-[#c4b5fd] bg-[#f5f3ff] text-[#6d28d9]";

export function verdictButtonClass(verdict: ParentReviewVerdict, selected: boolean): string {
    return selected ? VERDICT_STYLE[verdict].buttonSelected : VERDICT_STYLE[verdict].buttonIdle;
}

export function verdictChipClass(verdict: ParentReviewVerdict): string {
    return VERDICT_STYLE[verdict].chip;
}
