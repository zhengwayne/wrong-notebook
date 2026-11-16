"use client";

import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import type { SourceQuestionSummary } from "@/lib/learning-path/service";
import { cn } from "@/lib/utils";

function preview(text: string | null | undefined, length = 120) {
    const value = (text || "").replace(/\s+/g, " ").trim();
    if (!value) return "";
    return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function SourceQuestionList({
    questions,
    className,
}: {
    questions?: SourceQuestionSummary[];
    className?: string;
}) {
    const { t } = useLanguage();
    if (!questions || questions.length === 0) {
        return <p className={cn("text-sm text-muted-foreground", className)}>{t.learn.noSourceQuestions}</p>;
    }
    return (
        <ul className={cn("space-y-2", className)}>
            <li className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.learn.sourceQuestions}</li>
            {questions.map((question) => (
                <li key={question.id} className="rounded-xl border border-border/70 bg-muted/40 p-3">
                    <p className="text-sm leading-relaxed">{preview(question.questionText, 160) || "—"}</p>
                    {question.wrongAnswerText && (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{t.learn.wrongAnswer}{t.common.colon}</span>
                            {preview(question.wrongAnswerText, 80)}
                        </p>
                    )}
                    {question.mistakeAnalysis && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{t.learn.mistakeCause}{t.common.colon}</span>
                            {preview(question.mistakeAnalysis, 80)}
                        </p>
                    )}
                    <Link href={`/error-items/${question.id}`} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
                        {t.learn.openItem}{question.shortId ? ` · ${question.shortId}` : ""}
                    </Link>
                </li>
            ))}
        </ul>
    );
}
