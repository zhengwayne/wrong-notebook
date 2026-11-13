"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { BookOpen, CalendarCheck, ListChecks, Target } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export interface HomeHeroProps {
    notebookCount: number;
    itemCount: number;
    /** 今日待复习的错题数，加载完成前为 null */
    dueCount: number | null;
    /** 从错题本页进入时的目标错题本名称 */
    targetNotebook?: string;
}

const subscribeNothing = () => () => {};

interface StatTileProps {
    href: string;
    icon: LucideIcon;
    label: string;
    shortLabel?: string;
    value: number | null;
    highlight?: boolean;
}

function StatTile({ href, icon: Icon, label, shortLabel, value, highlight = false }: StatTileProps) {
    return (
        <Link
            href={href}
            className={cn(
                "group rounded-xl border px-3.5 py-3 backdrop-blur-sm transition-all outline-none hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-white/90",
                highlight
                    ? "border-amber-300/35 bg-amber-400/18 hover:bg-amber-400/25"
                    : "border-white/15 bg-white/12 hover:bg-white/20"
            )}
        >
            <div className="flex items-center gap-1.5 text-xs leading-tight text-white/85">
                <Icon
                    className={cn("h-3.5 w-3.5 shrink-0", highlight && "text-amber-200")}
                    aria-hidden="true"
                />
                {shortLabel ? (
                    <>
                        <span className="sm:hidden">{shortLabel}</span>
                        <span className="hidden sm:inline">{label}</span>
                    </>
                ) : (
                    <span className="min-w-0 whitespace-normal break-words">{label}</span>
                )}
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-white">
                {value ?? "–"}
            </div>
        </Link>
    );
}

/** 首页顶部欢迎区：温润墨青手账横幅 + 错题本/错题统计 + 琥珀今日待复习提醒 */
export function HomeHero({ notebookCount, itemCount, dueCount, targetNotebook }: HomeHeroProps) {
    const { t, language } = useLanguage();
    const { data: session } = useSession();
    // 问候语依赖本地时间，服务端渲染时返回 null，避免两端渲染不一致
    const hour = useSyncExternalStore(subscribeNothing, () => new Date().getHours(), () => null);

    const greeting = hour === null
        ? t.common.welcome.replace(/[，,\s]+$/, "")
        : hour < 12 ? t.home.greetingMorning
            : hour < 18 ? t.home.greetingAfternoon
                : t.home.greetingEvening;
    const name = session?.user?.name || session?.user?.email || "";

    return (
        <section
            aria-labelledby="home-hero-heading"
            className="relative overflow-hidden rounded-2xl border border-teal-900/15 bg-gradient-to-br from-[#165e5d] via-[#1b6e6a] to-[#245968] p-5 text-white shadow-lg shadow-teal-950/12 dark:border-teal-300/15 dark:from-[#194748] dark:via-[#1d5554] dark:to-[#1d424f] md:p-7"
        >
            {/* 柔和宣纸暖光与水墨晕染装饰层 */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-12 -top-14 h-48 w-48 rounded-full bg-amber-200/15 blur-3xl"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-16 right-20 h-44 w-44 rounded-full bg-teal-200/15 blur-2xl"
            />

            <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
                <div className="space-y-2">
                    <h1 id="home-hero-heading" className="text-xl font-bold tracking-tight md:text-2xl">
                        {greeting}{name && `${language === "zh" ? "，" : ", "}${name}`}
                    </h1>
                    <p className="max-w-md text-sm leading-relaxed text-white/85">{t.home.heroSubtitle}</p>
                    {targetNotebook && (
                        <p className="inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/15 px-3 py-1 text-xs font-medium">
                            <Target className="h-3.5 w-3.5 shrink-0 text-amber-200" aria-hidden="true" />
                            <span className="truncate">{t.home.targetNotebook.replace("{name}", targetNotebook)}</span>
                        </p>
                    )}
                </div>

                <div className="grid grid-cols-3 gap-2.5 sm:gap-3 md:w-96">
                    <StatTile href="/notebooks" icon={BookOpen} label={t.home.notebookCount} value={notebookCount} />
                    <StatTile href="/notebooks" icon={ListChecks} label={t.home.itemCount} value={itemCount} />
                    <StatTile
                        href="/review"
                        icon={CalendarCheck}
                        label={t.home.dueCount}
                        shortLabel={t.home.dueCountShort}
                        value={dueCount}
                        highlight={typeof dueCount === "number" && dueCount > 0}
                    />
                </div>
            </div>
        </section>
    );
}
