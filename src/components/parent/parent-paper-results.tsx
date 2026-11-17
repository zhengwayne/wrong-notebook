"use client";

import Link from "next/link";
import { BookOpen, CalendarCheck, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ImportedNotebookCount, ParentPaperReviewSummary } from "@/lib/parent-paper-summary";
import { NEEDS_CONFIRM_CHIP, verdictChipClass } from "@/lib/parent-paper-verdict-style";

const COUNT_STYLES = {
    correct: verdictChipClass("correct"),
    wrong: verdictChipClass("wrong"),
    partial: verdictChipClass("partial"),
    needs: NEEDS_CONFIRM_CHIP,
} as const;

interface ParentPaperResultsProps {
    summary: ParentPaperReviewSummary;
    hasAnswerKey: boolean;
    scoreLabel: string | null;
    confirmed: boolean;
    importedNotebooks: ImportedNotebookCount[];
    importedCount: number;
    hrefWithChild: (href: string) => string;
}

export function ParentPaperResults({
    summary,
    hasAnswerKey,
    scoreLabel,
    confirmed,
    importedNotebooks,
    importedCount,
    hrefWithChild,
}: ParentPaperResultsProps) {
    const { t } = useLanguage();
    const copy = t.parentPapers;
    const counts = [
        { key: "correct" as const, label: copy.resultCorrect, value: summary.correct },
        { key: "wrong" as const, label: copy.resultWrong, value: summary.wrong },
        { key: "partial" as const, label: copy.resultPartial, value: summary.partial },
        { key: "needs" as const, label: copy.resultNeedsConfirm, value: summary.needsConfirmation },
    ];

    return (
        <section aria-labelledby="parent-paper-results-title" className="space-y-4 rounded-2xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="parent-paper-results-title" className="text-base font-semibold">{copy.resultsTitle}</h2>
                {hasAnswerKey && scoreLabel ? (
                    <p className="text-sm font-medium text-foreground">{scoreLabel}</p>
                ) : (
                    <p className="text-sm text-muted-foreground">{copy.noScore}</p>
                )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {counts.map((item) => {
                    const style = COUNT_STYLES[item.key];
                    return (
                        <div key={item.key} className={`rounded-2xl border px-3 py-2.5 ${style}`}>
                            <div className="text-xs font-medium">{item.label}</div>
                            <div className="mt-1 text-xl font-semibold tabular-nums">
                                {copy.resultCount.replace("{count}", String(item.value))}
                            </div>
                        </div>
                    );
                })}
            </div>

            {summary.knowledgePoints.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-sm font-medium">{copy.knowledgePoints}</h3>
                    <div className="flex flex-wrap gap-1.5">
                        {summary.knowledgePoints.map((point) => (
                            <span key={point} className="rounded-full border border-[#ddd6fe] bg-[#f5f3ff] px-2.5 py-1 text-xs text-[#5b4b8a]">
                                {point}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {summary.errorCauses.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-sm font-medium">{copy.errorCauses}</h3>
                    <div className="flex flex-wrap gap-1.5">
                        {summary.errorCauses.map((cause) => (
                            <span key={cause} className="rounded-full border border-[#e8d4c8] bg-[#fbf3ee] px-2.5 py-1 text-xs text-[#8a5a48]">
                                {cause}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {confirmed && (
                <div className="space-y-3 border-t border-border pt-3">
                    <h3 className="text-sm font-semibold">{copy.doneTitle}</h3>
                    {importedNotebooks.length ? importedNotebooks.map((notebook) => (
                        <p key={notebook.subjectId} className="text-sm">
                            {copy.importedInto
                                .replace("{count}", String(notebook.count))
                                .replace("{name}", notebook.subjectName)}
                        </p>
                    )) : (
                        <p className="text-sm text-muted-foreground">{copy.doneNone}</p>
                    )}
                    <p className="text-sm text-muted-foreground">
                        {importedCount > 0 ? copy.pathReplanned : copy.pathNotReplanned}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        {importedNotebooks.map((notebook) => (
                            <Button key={notebook.subjectId} asChild variant="outline" size="sm" className="justify-start">
                                <Link href={hrefWithChild(`/notebooks/${notebook.subjectId}`)}>
                                    <BookOpen className="h-4 w-4" aria-hidden="true" />
                                    {copy.openNotebook.replace("{name}", notebook.subjectName)}
                                </Link>
                            </Button>
                        ))}
                        <Button asChild variant="outline" size="sm" className="justify-start">
                            <Link href={hrefWithChild("/review")}>
                                <CalendarCheck className="h-4 w-4" aria-hidden="true" />
                                {copy.openReview}
                            </Link>
                        </Button>
                        <Button asChild variant="outline" size="sm" className="justify-start">
                            <Link href={hrefWithChild("/learn")}>
                                <Route className="h-4 w-4" aria-hidden="true" />
                                {copy.openPath}
                            </Link>
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}
