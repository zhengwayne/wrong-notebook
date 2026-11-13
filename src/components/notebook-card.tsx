"use client";

import Link from "next/link";
import { Atom, BookOpen, BookText, ChevronRight, FlaskConical, Globe, Landmark, Languages, Leaf, Scale, Sigma } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NotebookScopeLabel } from "@/components/notebook-scope-label";
import { resolveNotebookScope } from "@/lib/notebook-scope";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import type { NotebookSubject } from "@/lib/notebook-scope";

export interface NotebookCardProps {
    name: string;
    stage?: string | null;
    subjectKey?: string | null;
    errorCount: number;
    /** 优先传入路由地址，渲染原生语义化 Link（支持新标签打开与完整无障碍导航） */
    href?: string;
    onClick?: () => void;
    itemLabel?: string;
    className?: string;
}

/** 各学科的温润纸墨风图标与配色，浅深色模式下均具备清晰辨识度 */
const SUBJECT_STYLE: Record<NotebookSubject, { icon: LucideIcon; className: string }> = {
    math: { icon: Sigma, className: "bg-teal-100/80 text-teal-700 dark:bg-teal-500/18 dark:text-teal-300" },
    english: { icon: Languages, className: "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-500/18 dark:text-emerald-300" },
    chinese: { icon: BookText, className: "bg-rose-100/80 text-rose-700 dark:bg-rose-500/18 dark:text-rose-300" },
    physics: { icon: Atom, className: "bg-amber-100/80 text-amber-700 dark:bg-amber-500/18 dark:text-amber-300" },
    chemistry: { icon: FlaskConical, className: "bg-cyan-100/80 text-cyan-700 dark:bg-cyan-500/18 dark:text-cyan-300" },
    biology: { icon: Leaf, className: "bg-lime-100/80 text-lime-700 dark:bg-lime-500/18 dark:text-lime-300" },
    history: { icon: Landmark, className: "bg-orange-100/80 text-orange-700 dark:bg-orange-500/18 dark:text-orange-300" },
    geography: { icon: Globe, className: "bg-sky-100/80 text-sky-700 dark:bg-sky-500/18 dark:text-sky-300" },
    politics: { icon: Scale, className: "bg-red-100/80 text-red-700 dark:bg-red-500/18 dark:text-red-300" },
};

const DEFAULT_STYLE = { icon: BookOpen, className: "bg-accent text-accent-foreground" };

export function NotebookCard({
    name,
    stage,
    subjectKey,
    errorCount,
    href,
    onClick,
    itemLabel,
    className,
}: NotebookCardProps) {
    const { t } = useLanguage();
    const resolvedItemLabel = itemLabel ?? t.notebooks.cardItems;
    const scope = resolveNotebookScope({ name, stage, subjectKey });
    const { icon: Icon, className: iconClass } = scope.subject ? SUBJECT_STYLE[scope.subject] : DEFAULT_STYLE;

    const cardBody = (
        <>
            <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105", iconClass)}>
                <Icon className="h-6 w-6" aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1 text-left">
                <h3 className="truncate font-semibold tracking-tight text-foreground">{name}</h3>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span className="font-semibold tabular-nums text-foreground">{errorCount}</span>
                    <span>{resolvedItemLabel}</span>
                    <span className="text-border" aria-hidden="true">|</span>
                    <NotebookScopeLabel notebook={{ name, stage, subjectKey }} className="truncate" />
                </p>
            </div>

            <ChevronRight
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary"
            />
        </>
    );

    const sharedClasses = cn(
        "surface-paper group relative flex w-full cursor-pointer items-center gap-4 rounded-2xl border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
    );

    if (href) {
        return (
            <Link href={href} onClick={onClick} className={sharedClasses}>
                {cardBody}
            </Link>
        );
    }

    return (
        <button type="button" onClick={onClick} className={sharedClasses}>
            {cardBody}
        </button>
    );
}
