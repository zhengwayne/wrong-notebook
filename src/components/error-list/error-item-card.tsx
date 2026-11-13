"use client";

import { useState } from "react";
import Link from "next/link";
import { DifficultyStars } from "@/components/difficulty-stars";
import { QuestionSummary } from "@/components/error-list/question-summary";
import { MASTERY_STATUS_BORDER, MasteryStatusBadge } from "@/components/mastery-status-badge";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { formatDateTime } from "@/lib/date-time";
import { getItemTags } from "@/lib/item-tags";
import { getMistakeStatusLabel } from "@/lib/mistake-status";
import { cn } from "@/lib/utils";
import type { ErrorItemSummary } from "@/types/api";

/** 卡片默认显示的知识点个数，其余折叠 */
const VISIBLE_TAGS = 3;
/** 题干摘要的最大字数 */
const SUMMARY_LENGTH = 80;

export interface ErrorItemCardProps {
    item: ErrorItemSummary;
    selectMode: boolean;
    selected: boolean;
    onToggleSelect: () => void;
    selectedTag: string | null;
    onTagClick: (tag: string) => void;
}

/**
 * 错题列表卡片：采用 Stretched-Link 模式解耦卡片主跳转链接与独立可聚焦的知识点标签按钮，
 * 消除 <a> 内嵌交互元素的无障碍违规，同时支持纯键盘独立操作每个标签与复选框。
 */
export function ErrorItemCard({
    item,
    selectMode,
    selected,
    onToggleSelect,
    selectedTag,
    onTagClick,
}: ErrorItemCardProps) {
    const { t, language } = useLanguage();
    const { timeZone } = useTimeZone();
    const [tagsExpanded, setTagsExpanded] = useState(false);
    const tags = getItemTags(item);
    const hiddenCount = tags.length - VISIBLE_TAGS;
    const status = item.masteryStatus ?? "new";

    return (
        <article
            className={cn(
                "surface-paper group relative flex h-full flex-col justify-between rounded-2xl border border-l-4 bg-card transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/25",
                MASTERY_STATUS_BORDER[status],
                selectMode && selected
                    ? "ring-2 ring-primary"
                    : "hover:border-y-primary/35 hover:border-r-primary/35"
            )}
        >
            {selectMode && (
                <div
                    className="absolute left-3.5 top-3.5 z-20"
                    onClick={(e) => e.stopPropagation()}
                >
                    <Checkbox
                        checked={selected}
                        onCheckedChange={() => onToggleSelect()}
                        aria-label={t.questionSimilarity.selectQuestion.replace("{id}", item.shortId || item.id)}
                        className="h-5 w-5 border-2 bg-card shadow-xs"
                    />
                </div>
            )}

            <Link
                href={`/error-items/${item.id}`}
                onClick={(e) => {
                    if (selectMode) {
                        e.preventDefault();
                        onToggleSelect();
                    }
                }}
                className="flex flex-1 flex-col gap-3 px-5 pt-4 pb-3 outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
                <div className={cn("flex items-start justify-between gap-2", selectMode && "pl-7")}>
                    <MasteryStatusBadge status={status} />
                    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                        {typeof item.masteryProbability === "number" && (
                            <span title={t.mastery.probability} className="font-medium text-foreground/80">
                                {Math.round(item.masteryProbability * 100)}%
                            </span>
                        )}
                        {item.shortId && <span className="font-mono">{item.shortId}</span>}
                        <span>{formatDateTime(item.createdAt, "MM/dd", timeZone)}</span>
                    </span>
                </div>

                <div className="min-w-0 break-words">
                    <QuestionSummary
                        text={item.questionText}
                        maxLength={SUMMARY_LENGTH}
                        className="line-clamp-3 text-sm leading-relaxed text-foreground"
                    />
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    <Badge variant="secondary" className="text-xs font-normal">
                        {getMistakeStatusLabel(item.mistakeStatus, language)}
                    </Badge>
                    <DifficultyStars value={item.difficultyStars} showUnrated={false} />
                </div>
            </Link>

            {tags.length > 0 && (
                <div className="relative z-10 flex flex-wrap gap-1.5 border-t border-border/50 px-5 py-3">
                    {(tagsExpanded ? tags : tags.slice(0, VISIBLE_TAGS)).map((tag) => {
                        const isTagSelected = selectedTag === tag;
                        return (
                            <button
                                key={tag}
                                type="button"
                                aria-pressed={isTagSelected}
                                onClick={() => onTagClick(tag)}
                                className={cn(
                                    "inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    isTagSelected
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border bg-background/80 text-foreground/85 hover:border-primary/45 hover:bg-accent hover:text-accent-foreground"
                                )}
                            >
                                <span className="truncate">{tag}</span>
                            </button>
                        );
                    })}
                    {hiddenCount > 0 && (
                        <button
                            type="button"
                            aria-expanded={tagsExpanded}
                            title={
                                tagsExpanded
                                    ? t.notebooks?.collapseTagsTooltip || "Click to collapse"
                                    : (t.notebooks?.expandTagsTooltip || "Click to expand {count} tags").replace(
                                          "{count}",
                                          hiddenCount.toString()
                                      )
                            }
                            onClick={() => setTagsExpanded((prev) => !prev)}
                            className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {tagsExpanded
                                ? t.notebooks?.collapseTags || "Collapse"
                                : (t.notebooks?.expandTags || "+{count} more").replace(
                                      "{count}",
                                      hiddenCount.toString()
                                  )}
                        </button>
                    )}
                </div>
            )}
        </article>
    );
}
