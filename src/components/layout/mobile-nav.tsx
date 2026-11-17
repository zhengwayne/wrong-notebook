"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { MoreHorizontal, Settings, Shield } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    isMobileMoreActive,
    mobileMoreItemsForPersona,
    mobilePrimaryItemsForPersona,
    type NavItem,
} from "@/lib/nav-items";
import type { Persona } from "@/lib/personas";
import { requestOpenSettings } from "@/lib/settings-events";
import { cn } from "@/lib/utils";

export function navLabel(
    t: { nav: Record<string, string> },
    key: NavItem["key"],
    compact = false,
    persona?: Persona | null,
): string {
    if (persona === "teacher" && key === "grading" && t.nav.gradingCollect) return t.nav.gradingCollect;
    if (compact && key === "learn" && t.nav.learnShort) return t.nav.learnShort;
    if (compact && key === "papers" && t.nav.papersShort) return t.nav.papersShort;
    return t.nav[key];
}

interface MobileNavProps {
    pathname: string;
    isAdmin: boolean;
    activePersona: Persona | null;
    hrefWithChild: (href: string) => string;
}

/** 移动端底部固定导航与「更多」抽屉菜单 */
export function MobileNav({ pathname, isAdmin, activePersona, hrefWithChild }: MobileNavProps) {
    const { t } = useLanguage();
    const [moreOpen, setMoreOpen] = useState(false);
    const moreTitleId = useId();
    const moreDescId = useId();
    const morePanelId = useId();

    const mobilePrimaryItems = mobilePrimaryItemsForPersona(activePersona);
    const mobileMoreItems = mobileMoreItemsForPersona(activePersona);
    const moreActive = isMobileMoreActive(pathname, activePersona);

    const openSettingsFromMore = () => {
        setMoreOpen(false);
        // 等「更多」面板关闭后再打开设置，避免两个模态框叠在一起
        window.setTimeout(() => requestOpenSettings(), 0);
    };

    return (
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <nav
                aria-label={t.nav.mobileNav}
                className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-card/92 backdrop-blur-md md:hidden print:hidden"
            >
                <div className="grid h-16 grid-cols-5 px-1">
                    {mobilePrimaryItems.map((item) => {
                        const active = item.match(pathname);
                        const Icon = item.icon;
                        const label = navLabel(t, item.key, true, activePersona);
                        return (
                            <Link
                                key={item.key}
                                href={hrefWithChild(item.href)}
                                className={cn(
                                    "flex min-w-0 flex-col items-center justify-center gap-1 px-0.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                    active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                                )}
                                aria-current={active ? "page" : undefined}
                            >
                                <span
                                    className={cn(
                                        "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                                        active && "bg-accent text-accent-foreground",
                                    )}
                                >
                                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                </span>
                                <span className="max-w-full truncate">{label}</span>
                            </Link>
                        );
                    })}
                    <SheetTrigger asChild>
                        <button
                            type="button"
                            className={cn(
                                "flex min-w-0 flex-col items-center justify-center gap-1 px-0.5 text-[11px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                moreActive || moreOpen ? "text-primary" : "text-muted-foreground hover:text-foreground",
                            )}
                            aria-haspopup="dialog"
                            aria-controls={morePanelId}
                            aria-current={moreActive ? "true" : undefined}
                        >
                            <span
                                className={cn(
                                    "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                                    (moreActive || moreOpen) && "bg-accent text-accent-foreground",
                                )}
                            >
                                <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
                            </span>
                            <span className="max-w-full truncate">{t.nav.more}</span>
                        </button>
                    </SheetTrigger>
                </div>
            </nav>
            <SheetContent
                id={morePanelId}
                closeLabel={t.common.close}
                aria-labelledby={moreTitleId}
                aria-describedby={moreDescId}
                className="md:hidden"
            >
                <div className="px-4 pb-4 pt-3">
                    <SheetTitle id={moreTitleId} className="text-base font-semibold tracking-tight">
                        {t.nav.more}
                    </SheetTitle>
                    <SheetDescription id={moreDescId} className="sr-only">
                        {t.nav.moreMenu}
                    </SheetDescription>
                    <ul className="mt-3 space-y-1" role="list">
                        {mobileMoreItems.map((item) => {
                            const active = item.match(pathname);
                            const Icon = item.icon;
                            return (
                                <li key={item.key}>
                                    <Link
                                        href={hrefWithChild(item.href)}
                                        aria-current={active ? "page" : undefined}
                                        onClick={() => setMoreOpen(false)}
                                        className={cn(
                                            "flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                            active
                                                ? "bg-accent text-accent-foreground"
                                                : "text-foreground hover:bg-muted/80",
                                        )}
                                    >
                                        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                        {navLabel(t, item.key, false, activePersona)}
                                    </Link>
                                </li>
                            );
                        })}
                        <li>
                            <button
                                type="button"
                                onClick={openSettingsFromMore}
                                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted/80 focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <Settings className="h-5 w-5 shrink-0" aria-hidden="true" />
                                {t.settings.title}
                            </button>
                        </li>
                        {isAdmin && (
                            <li>
                                <Link
                                    href="/admin"
                                    aria-current={pathname.startsWith("/admin") ? "page" : undefined}
                                    onClick={() => setMoreOpen(false)}
                                    className={cn(
                                        "flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                        pathname.startsWith("/admin")
                                            ? "bg-accent text-accent-foreground"
                                            : "text-foreground hover:bg-muted/80",
                                    )}
                                >
                                    <Shield className="h-5 w-5 shrink-0" aria-hidden="true" />
                                    {t.nav.admin}
                                </Link>
                            </li>
                        )}
                    </ul>
                </div>
            </SheetContent>
        </Sheet>
    );
}
