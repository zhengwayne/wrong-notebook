"use client";

import Link from "next/link";
import { CalendarClock, Route, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { formatDateTime } from "@/lib/date-time";
import type { ErrorItemDetail } from "@/components/error-detail/types";

export function ErrorItemLearningCard({ item }: { item: ErrorItemDetail }) {
    const { t } = useLanguage();
    const { timeZone } = useTimeZone();
    const learning = item.learning;
    const nextLabel = !learning
        ? null
        : learning.nextReviewAt == null
            ? t.detail.reviewDone
            : learning.reviewDue
                ? t.detail.nextReviewToday
                : t.detail.nextReview + t.common.colon + formatDateTime(learning.nextReviewAt, "yyyy/MM/dd", timeZone);

    return (
        <section className="rounded-2xl border border-border/70 bg-card p-4 sm:p-5 space-y-4" data-testid="error-item-learning">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                    <h2 className="text-base font-semibold tracking-tight">{t.learn.mastery}</h2>
                    {nextLabel && (
                        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <CalendarClock className="h-4 w-4 shrink-0" aria-hidden="true" />
                            {nextLabel}
                        </p>
                    )}
                </div>
                <Button asChild size="sm">
                    <Link href={`/practice?id=${item.id}`}>
                        <Sparkles className="h-4 w-4" aria-hidden="true" />
                        {t.detail.practiseSimilar}
                    </Link>
                </Button>
            </div>
            {learning && learning.knowledgeMastery.length > 0 && (
                <div>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">{t.detail.knowledgeMastery}</p>
                    <ul className="space-y-2">
                        {learning.knowledgeMastery.map((row) => (
                            <li key={row.knowledgePoint}>
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span className="truncate">{row.knowledgePoint}</span>
                                    <span className="tabular-nums">{Math.round(row.score * 100)}%</span>
                                </div>
                                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(row.score * 100)}%` }} />
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Route className="h-3.5 w-3.5" aria-hidden="true" />
                    {t.detail.pathStep}
                </p>
                {learning && learning.pathSteps.length > 0 ? (
                    <ul className="space-y-2">
                        {learning.pathSteps.map((step) => (
                            <li key={step.id} className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Link href="/learn" className="text-sm font-medium text-primary hover:underline">{step.title}</Link>
                                    <Badge variant="outline">{step.status}</Badge>
                                </div>
                                {step.reason && <p className="mt-1 text-xs text-muted-foreground">{step.reason}</p>}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">{t.detail.noPathStep}</p>
                )}
            </div>
        </section>
    );
}
