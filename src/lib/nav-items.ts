import { BarChart3, BookOpen, CalendarCheck, Camera, ClipboardCheck, FileText, PlusCircle, Route, Sparkles, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Persona } from "@/lib/personas";
import { landingPath } from "@/lib/personas";

export type NavKey =
    | "home"
    | "notebooks"
    | "review"
    | "learn"
    | "stats"
    | "exams"
    | "grading"
    | "variants"
    | "classes"
    | "children"
    | "todayTasks"
    | "practice"
    | "path"
    | "papers";

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

export const TEACHER_NAV_ITEMS: NavItem[] = [
    { key: "grading", href: "/grading", icon: ClipboardCheck, match: (p) => p.startsWith("/grading") && !p.startsWith("/teacher") },
    { key: "classes", href: "/teacher", icon: Users, match: (p) => p.startsWith("/teacher") },
    { key: "stats", href: "/stats", icon: BarChart3, match: (p) => p.startsWith("/stats") || p.startsWith("/tags") },
    {
        key: "notebooks",
        href: "/notebooks",
        icon: BookOpen,
        match: (p) => p.startsWith("/notebooks") || p.startsWith("/error-items") || p.startsWith("/practice"),
    },
    { key: "learn", href: "/learn", icon: Route, match: (p) => p.startsWith("/learn") },
    { key: "review", href: "/review", icon: CalendarCheck, match: (p) => p.startsWith("/review") },
    { key: "exams", href: "/exams", icon: FileText, match: (p) => p.startsWith("/exams") },
];

export const PARENT_NAV_ITEMS: NavItem[] = [
    { key: "children", href: "/parent", icon: Users, match: (p) => p === "/parent" },
    { key: "papers", href: "/parent/papers/new", icon: Camera, match: (p) => p.startsWith("/parent/papers") },
    { key: "todayTasks", href: "/review", icon: CalendarCheck, match: (p) => p.startsWith("/review") },
    {
        key: "practice",
        href: "/notebooks",
        icon: BookOpen,
        match: (p) => p.startsWith("/notebooks") || p.startsWith("/error-items") || p.startsWith("/practice"),
    },
    { key: "path", href: "/learn", icon: Route, match: (p) => p.startsWith("/learn") },
    { key: "stats", href: "/stats", icon: BarChart3, match: (p) => p.startsWith("/stats") || p.startsWith("/tags") },
    { key: "exams", href: "/exams", icon: FileText, match: (p) => p.startsWith("/exams") },
];

const TEACHER_MOBILE_PRIMARY_KEYS = ["grading", "classes", "stats", "notebooks"] as const;
const PARENT_MOBILE_PRIMARY_KEYS = ["children", "papers", "practice", "path"] as const;

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

export function navItemsForPersona(persona: Persona | null | undefined): NavItem[] {
    if (persona === "teacher") return TEACHER_NAV_ITEMS;
    if (persona === "parent") return PARENT_NAV_ITEMS;
    return NAV_ITEMS;
}

export function mobilePrimaryItemsForPersona(persona: Persona | null | undefined): NavItem[] {
    if (persona === "teacher") {
        return TEACHER_NAV_ITEMS.filter((item) =>
            (TEACHER_MOBILE_PRIMARY_KEYS as readonly string[]).includes(item.key)
        );
    }
    if (persona === "parent") {
        return PARENT_NAV_ITEMS.filter((item) =>
            (PARENT_MOBILE_PRIMARY_KEYS as readonly string[]).includes(item.key)
        );
    }
    return MOBILE_PRIMARY_ITEMS;
}

export function mobileMoreItemsForPersona(persona: Persona | null | undefined): NavItem[] {
    if (persona === "teacher") {
        const primary = new Set<string>(TEACHER_MOBILE_PRIMARY_KEYS);
        return [...TEACHER_NAV_ITEMS.filter((item) => !primary.has(item.key)), VARIANTS_NAV_ITEM];
    }
    if (persona === "parent") {
        const primary = new Set<string>(PARENT_MOBILE_PRIMARY_KEYS);
        return PARENT_NAV_ITEMS.filter((item) => !primary.has(item.key));
    }
    return MOBILE_MORE_ITEMS;
}

export function homeHrefForPersona(persona: Persona | null | undefined): string {
    return landingPath(persona);
}

export function isMobilePrimaryActive(pathname: string, persona?: Persona | null): boolean {
    return mobilePrimaryItemsForPersona(persona).some((item) => item.match(pathname));
}

export function isMobileMoreActive(pathname: string, persona?: Persona | null): boolean {
    return mobileMoreItemsForPersona(persona).some((item) => item.match(pathname)) || pathname.startsWith("/admin");
}
