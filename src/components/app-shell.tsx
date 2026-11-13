"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { BarChart3, BookOpen, CalendarCheck, ClipboardCheck, FileText, LogOut, PlusCircle, Route, Shield } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useLanguage } from "@/contexts/LanguageContext";
import { useSetupRedirect } from "@/lib/use-setup-redirect";
import { cn } from "@/lib/utils";

/** 登录、注册与打印页不显示导航 */
const BARE_PATHS = [/^\/login/, /^\/register/, /^\/setup/, /^\/print-preview/, /^\/exams\/[^/]+\/print/];

type NavKey = "home" | "notebooks" | "review" | "learn" | "stats" | "exams" | "grading";

interface NavItem {
    key: NavKey;
    href: string;
    icon: LucideIcon;
    match: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
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

/** 全局导航外壳：支持键盘 SkipLink、区分性地标、桌面端顶栏与移动端底部安全导航栏 */
export function AppShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname() || "/";
    const { t } = useLanguage();
    const { data: session, status } = useSession();
    const isAdmin = session?.user?.role === "admin";
    const isBare = BARE_PATHS.some((pattern) => pattern.test(pathname));
    useSetupRedirect(isAdmin && !isBare);

    if (isBare || status === "unauthenticated") {
        return <ErrorBoundary>{children}</ErrorBoundary>;
    }

    const userName = session?.user?.name || session?.user?.email || "";

    return (
        <div className="min-h-screen">
            {/* 键盘用户按 Tab 首先聚焦的跳过导航锚点 */}
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[110] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
            >
                {t.nav.skipToContent}
            </a>

            <header className="sticky top-0 z-40 border-b border-border/80 bg-card/85 backdrop-blur-md supports-[backdrop-filter]:bg-card/75 print:hidden">
                <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:h-16 md:px-8">
                    <Link
                        href="/"
                        className="flex shrink-0 items-center gap-2.5 rounded-lg py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Image
                            src="/icons/icon.png"
                            alt=""
                            width={32}
                            height={32}
                            className="rounded-lg ring-1 ring-border/60"
                            priority
                            unoptimized
                        />
                        <span className="text-base font-semibold tracking-tight">{t.pageTitle.base}</span>
                    </Link>

                    <nav aria-label={t.nav.primaryNav} className="ml-4 hidden items-center gap-1 md:flex">
                        {NAV_ITEMS.map((item) => {
                            const active = item.match(pathname);
                            const Icon = item.icon;
                            return (
                                <Link
                                    key={item.key}
                                    href={item.href}
                                    className={cn(
                                        "relative flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        active
                                            ? "bg-accent text-accent-foreground shadow-2xs"
                                            : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                                    )}
                                    aria-current={active ? "page" : undefined}
                                >
                                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                                    {t.nav[item.key]}
                                </Link>
                            );
                        })}
                    </nav>

                    <div className="ml-auto flex items-center gap-1">
                        {userName && (
                            <span className="mr-2 hidden max-w-44 items-center gap-2 truncate rounded-full border border-border/70 bg-muted/50 py-1 pl-1.5 pr-3 text-xs font-medium text-muted-foreground lg:flex">
                                <span
                                    aria-hidden="true"
                                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
                                >
                                    {userName.slice(0, 1).toUpperCase()}
                                </span>
                                <span className="truncate text-foreground/85">{userName}</span>
                            </span>
                        )}
                        {isAdmin && (
                            <Button asChild variant="ghost" size="icon" className="rounded-full">
                                <Link href="/admin" title={t.nav.admin} aria-label={t.nav.admin}>
                                    <Shield className="h-5 w-5" aria-hidden="true" />
                                </Link>
                            </Button>
                        )}
                        <ThemeToggle />
                        <SettingsDialog />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="rounded-full text-muted-foreground hover:text-destructive"
                            onClick={() => signOut({ callbackUrl: "/login" })}
                            title={t.app.logout}
                            aria-label={t.app.logout}
                        >
                            <LogOut className="h-5 w-5" aria-hidden="true" />
                        </Button>
                    </div>
                </div>
            </header>

            <div className="pb-20 md:pb-0">
                <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
            </div>

            <nav
                aria-label={t.nav.mobileNav}
                className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-card/92 backdrop-blur-md md:hidden print:hidden"
            >
                <div className="grid h-16 grid-cols-6 px-1">
                    {NAV_ITEMS.map((item) => {
                        const active = item.match(pathname);
                        const Icon = item.icon;
                        return (
                            <Link
                                key={item.key}
                                href={item.href}
                                className={cn(
                                    "flex min-w-0 flex-col items-center justify-center gap-1 px-0.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                    active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                                )}
                                aria-current={active ? "page" : undefined}
                            >
                                <span
                                    className={cn(
                                        "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                                        active && "bg-accent text-accent-foreground"
                                    )}
                                >
                                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                </span>
                                <span className="max-w-full truncate">{t.nav[item.key]}</span>
                            </Link>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
}
