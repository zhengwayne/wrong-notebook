"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { LogOut, Settings, Shield } from "lucide-react";
import { MobileNav, navLabel } from "@/components/layout/mobile-nav";
import { GlobalKidModeBanner, useKidModeState } from "@/components/parent/kid-mode-lock-bar";
import { PersonaSwitcher } from "@/components/persona-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useLanguage } from "@/contexts/LanguageContext";
import { homeHrefForPersona, navItemsForPersona, type NavItem } from "@/lib/nav-items";
import type { Persona } from "@/lib/personas";
import { OPEN_SETTINGS_EVENT } from "@/lib/settings-events";
import { useCurrentChild } from "@/lib/use-current-child";
import { useSetupRedirect } from "@/lib/use-setup-redirect";
import { cn } from "@/lib/utils";

const LazySettingsDialog = dynamic(
    () => import("@/components/settings-dialog").then((m) => m.SettingsDialog),
    { ssr: false },
);

/** 登录、注册与打印页不显示导航 */
const BARE_PATHS = [/^\/login/, /^\/register/, /^\/setup/, /^\/initialize/, /^\/onboarding/, /^\/print-preview/, /^\/exams\/[^/]+\/print/];

function NavLink({
    item,
    pathname,
    persona,
    href,
    className,
}: {
    item: NavItem;
    pathname: string;
    persona?: Persona | null;
    href?: string;
    className?: string;
}) {
    const { t } = useLanguage();
    const active = item.match(pathname);
    const Icon = item.icon;
    const label = navLabel(t, item.key, false, persona);
    return (
        <Link
            href={href || item.href}
            className={className}
            aria-current={active ? "page" : undefined}
        >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {label}
        </Link>
    );
}

/** 全局导航外壳：支持键盘 SkipLink、区分性地标、桌面端顶栏与移动端底部安全导航栏 */
export function AppShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname() || "/";
    const { t } = useLanguage();
    const { data: session, status } = useSession();
    const isAdmin = session?.user?.role === "admin";
    const activePersona = session?.user?.activePersona ?? null;
    const navItems = navItemsForPersona(activePersona);
    const homeHref = homeHrefForPersona(activePersona);
    const { hrefWithChild } = useCurrentChild();
    const isBare = BARE_PATHS.some((pattern) => pattern.test(pathname));
    useSetupRedirect(isAdmin && !isBare);
    const { state: kidMode } = useKidModeState(status === "authenticated" && !isBare);
    const kidLocked = Boolean(kidMode?.active);
    const visibleNavItems = kidLocked
        ? navItems.filter((item) => item.href === "/learn" || item.href === "/review")
        : navItems;
    const effectiveHomeHref = kidLocked && kidMode?.learnerId
        ? `/learn?studentKey=${encodeURIComponent(kidMode.learnerId)}`
        : homeHref;
    const [settingsMounted, setSettingsMounted] = useState(false);

    useEffect(() => {
        const onOpen = () => setSettingsMounted(true);
        window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
    }, []);

    if (isBare || status === "unauthenticated") {
        return <ErrorBoundary>{children}</ErrorBoundary>;
    }

    const userName = session?.user?.name || session?.user?.email || "";

    return (
        <div className="min-h-screen">
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[110] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
            >
                {t.nav.skipToContent}
            </a>

            {kidLocked && kidMode && <GlobalKidModeBanner state={kidMode} />}

            <header className="sticky top-0 z-40 border-b border-border/80 bg-card/85 backdrop-blur-md supports-[backdrop-filter]:bg-card/75 print:hidden">
                <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:h-16 md:px-8">
                    <Link
                        href={effectiveHomeHref}
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
                        {visibleNavItems.map((item) => {
                            const active = item.match(pathname);
                            return (
                                <NavLink
                                    key={item.key}
                                    item={item}
                                    href={hrefWithChild(item.href)}
                                    pathname={pathname}
                                    persona={activePersona}
                                    className={cn(
                                        "relative flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        active
                                            ? "bg-accent text-accent-foreground shadow-2xs"
                                            : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                                    )}
                                />
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
                        {!kidLocked && <PersonaSwitcher />}
                        {!kidLocked && isAdmin && (
                            <Button asChild variant="ghost" size="icon" className="rounded-full">
                                <Link href="/admin" title={t.nav.admin} aria-label={t.nav.admin}>
                                    <Shield className="h-5 w-5" aria-hidden="true" />
                                </Link>
                            </Button>
                        )}
                        <ThemeToggle />
                        {!kidLocked && (
                            settingsMounted ? (
                                <LazySettingsDialog defaultOpen />
                            ) : (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="rounded-full"
                                    onClick={() => setSettingsMounted(true)}
                                    title={t.settings?.title || "Settings"}
                                    aria-label={t.settings?.title || "Settings"}
                                >
                                    <Settings className="h-5 w-5" />
                                </Button>
                            )
                        )}
                        {!kidLocked && (
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
                        )}
                    </div>
                </div>
            </header>

            <div className="pb-[calc(7.5rem+env(safe-area-inset-bottom,0px))] md:pb-0">
                <ErrorBoundary key={pathname}>{children}</ErrorBoundary>
            </div>

            {!kidLocked && (
                <MobileNav
                    pathname={pathname}
                    isAdmin={isAdmin}
                    activePersona={activePersona}
                    hrefWithChild={hrefWithChild}
                />
            )}
        </div>
    );
}
