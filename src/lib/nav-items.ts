import { BarChart3, BookOpen, CalendarCheck, ClipboardCheck, FileText, PlusCircle, Route, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavKey = "home" | "notebooks" | "review" | "learn" | "stats" | "exams" | "grading" | "variants";

export interface NavItem {
    key: NavKey;
    href: string;
    icon: LucideIcon;
    match: (pathname: string) => boolean;
}

/** 桌面顶栏仍展示全部常用入口（含复习与试卷）；变式审核放在移动端「更多」以免顶栏过挤 */
export const NAV_ITEMS: NavItem[] = [
    { key: "home", href: "/", icon: PlusCircle, match: (p) => p === "/" },
    {
        key: "notebooks",
        href: "/notebooks",
        icon: BookOpen,
        match: (p) => p.startsWith("/notebooks") || p.startsWith("/error-items") || p.startsWith("/practice"),
    },
    { key: "review", href: "/review", icon: CalendarCheck, match: (p) => p.startsWith("/review") },
    { key: "learn", href: "/learn", icon: Route, match: (p) => p.startsWith("/learn") },
    { key: "stats", href: "/stats", icon: BarChart3, match: (p) => p.startsWith("/stats") || p.startsWith("/tags") },
    { key: "exams", href: "/exams", icon: FileText, match: (p) => p.startsWith("/exams") },
    { key: "grading", href: "/grading", icon: ClipboardCheck, match: (p) => p.startsWith("/grading") },
];

export const VARIANTS_NAV_ITEM: NavItem = {
    key: "variants",
    href: "/variants",
    icon: Sparkles,
    match: (p) => p.startsWith("/variants"),
};

export const MOBILE_PRIMARY_KEYS = ["home", "notebooks", "learn", "grading"] as const;

export const MOBILE_PRIMARY_ITEMS: NavItem[] = NAV_ITEMS.filter((item) =>
    (MOBILE_PRIMARY_KEYS as readonly string[]).includes(item.key)
);

export const MOBILE_MORE_ITEMS: NavItem[] = [
    NAV_ITEMS.find((item) => item.key === "review")!,
    VARIANTS_NAV_ITEM,
    NAV_ITEMS.find((item) => item.key === "stats")!,
    NAV_ITEMS.find((item) => item.key === "exams")!,
];

export function isMobilePrimaryActive(pathname: string): boolean {
    return MOBILE_PRIMARY_ITEMS.some((item) => item.match(pathname));
}

export function isMobileMoreActive(pathname: string): boolean {
    return MOBILE_MORE_ITEMS.some((item) => item.match(pathname)) || pathname.startsWith("/admin");
}
