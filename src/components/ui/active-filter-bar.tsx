"use client";

import * as React from "react";
import { FilterX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export interface FilterChipItem {
    /** 唯一标识 */
    key: string;
    /** 展示文案 */
    label: string;
    /** 点击移除该筛选条件 */
    onRemove: () => void;
}

export interface ActiveFilterBarProps {
    /** 当前激活的筛选项列表；为空数组时不渲染 */
    items: FilterChipItem[];
    /** 点击「清空筛选」回调 */
    onClearAll?: () => void;
    clearAllLabel?: string;
    prefixLabel?: string;
    className?: string;
}

/** 汇总展示当前激活的筛选条件胶囊，支持键盘独立聚焦移除与一键重置 */
export function ActiveFilterBar({
    items,
    onClearAll,
    clearAllLabel,
    prefixLabel,
    className,
}: ActiveFilterBarProps) {
    const { t } = useLanguage();

    if (items.length === 0) return null;

    const resolvedPrefix = prefixLabel ?? t.filter.activeFilters;
    const resolvedClearAll = clearAllLabel ?? t.common.clearFilters;

    return (
        <div
            role="region"
            aria-label={resolvedPrefix}
            className={cn(
                "flex flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-muted/60 px-3.5 py-2.5",
                className
            )}
        >
            <span className="text-xs font-medium text-muted-foreground">
                {resolvedPrefix}
                {t.common.colon}
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
                {items.map((chip) => (
                    <button
                        key={chip.key}
                        type="button"
                        onClick={chip.onRemove}
                        aria-label={t.filter.removeFilter.replace("{label}", chip.label)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-2xs transition-colors hover:border-primary/50 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <span className="max-w-48 truncate">{chip.label}</span>
                        <X className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                ))}
            </div>
            {onClearAll && items.length > 1 && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onClearAll}
                    className="ml-auto h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                >
                    <FilterX className="h-3.5 w-3.5" aria-hidden="true" />
                    {resolvedClearAll}
                </Button>
            )}
        </div>
    );
}

