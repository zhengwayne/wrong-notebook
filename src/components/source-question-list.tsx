"use client";

import Link from "next/link";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useLanguage } from "@/contexts/LanguageContext";
import type { SourceQuestionSummary } from "@/lib/learning-path/service";
import { cn } from "@/lib/utils";

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
                    <MarkdownRenderer
                        content={question.questionText || "—"}
                        variant="compact"
                        clamp={4}
                        className="text-sm leading-relaxed"
                    />
                    {question.wrongAnswerText && (
                        <div className="mt-1.5 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{t.learn.wrongAnswer}{t.common.colon}</span>
                            <MarkdownRenderer content={question.wrongAnswerText} variant="compact" clamp={2} className="text-xs text-muted-foreground" />
                        </div>
                    )}
                    {question.mistakeAnalysis && (
                        <div className="mt-1 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{t.learn.mistakeCause}{t.common.colon}</span>
                            <MarkdownRenderer content={question.mistakeAnalysis} variant="compact" clamp={2} className="text-xs text-muted-foreground" />
                        </div>
                    )}
                    <Link href={`/error-items/${question.id}`} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
                        {t.learn.openItem}{question.shortId ? ` · ${question.shortId}` : ""}
                    </Link>
                </li>
            ))}
        </ul>
    );
}
