"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ParsedQuestion } from "@/lib/ai/types";
import { defaultSelectedAnalyzeItems } from "@/lib/ai/parse-analyze";
import { Badge } from "@/components/ui/badge";

function statusLabel(status: ParsedQuestion["mistakeStatus"] | undefined, t: { importFlow: { statusWrong: string; statusUnattempted: string; statusUnknown: string } }) {
    if (status === "wrong_attempt") return t.importFlow.statusWrong;
    if (status === "not_attempted") return t.importFlow.statusUnattempted;
    return t.importFlow.statusUnknown;
}

export function MultiQuestionConfirm({
    items,
    saving,
    onCancel,
    onSave,
}: {
    items: ParsedQuestion[];
    saving?: boolean;
    onCancel: () => void;
    onSave: (selected: ParsedQuestion[]) => Promise<void> | void;
}) {
    const { t } = useLanguage();
    const [selected, setSelected] = useState<boolean[]>(() => defaultSelectedAnalyzeItems(items));
    const count = selected.filter(Boolean).length;

    const toggle = (index: number, value: boolean) => {
        setSelected((current) => current.map((item, i) => (i === index ? value : item)));
    };

    const statusHint = useMemo(() => t.importFlow.selectedCount
        .replace("{selected}", String(count))
        .replace("{total}", String(items.length)), [count, items.length, t.importFlow.selectedCount]);

    return (
        <div className="mx-auto max-w-3xl space-y-5" data-testid="multi-question-confirm">
            <div className="space-y-1.5">
                <h2 className="text-xl font-semibold tracking-tight">{t.importFlow.multiTitle}</h2>
                <p className="text-sm text-muted-foreground">{t.importFlow.multiHint}</p>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setSelected(items.map(() => true))}>
                    {t.importFlow.selectAll}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setSelected(defaultSelectedAnalyzeItems(items))}>
                    {t.importFlow.selectWrong}
                </Button>
                <span className="self-center text-xs text-muted-foreground">{statusHint}</span>
            </div>
            <ul className="space-y-3">
                {items.map((item, index) => (
                    <li key={`${item.questionText.slice(0, 24)}-${index}`}>
                        <label className="flex cursor-pointer gap-3 rounded-2xl border border-border/70 bg-card p-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                            <Checkbox
                                checked={selected[index]}
                                onCheckedChange={(value) => toggle(index, value === true)}
                                className="mt-1"
                                aria-label={`${t.importFlow.selectedCount} ${index + 1}`}
                            />
                            <div className="min-w-0 flex-1 space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-semibold">{index + 1}</span>
                                    <Badge variant={item.mistakeStatus === "wrong_attempt" ? "default" : "outline"}>
                                        {statusLabel(item.mistakeStatus, t)}
                                    </Badge>
                                    {item.knowledgePoints?.slice(0, 4).map((point) => (
                                        <Badge key={point} variant="outline">{point}</Badge>
                                    ))}
                                </div>
                                <MarkdownRenderer content={item.questionText} variant="compact" clamp={6} className="text-sm leading-relaxed" />
                                {item.wrongAnswerText && (
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-medium text-foreground">{t.learn.wrongAnswer}{t.common.colon}</span>
                                        <MarkdownRenderer content={item.wrongAnswerText} variant="compact" clamp={2} className="text-xs text-muted-foreground" />
                                    </div>
                                )}
                                {item.mistakeAnalysis && (
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-medium text-foreground">{t.learn.mistakeCause}{t.common.colon}</span>
                                        <MarkdownRenderer content={item.mistakeAnalysis} variant="compact" clamp={3} className="text-xs text-muted-foreground" />
                                    </div>
                                )}
                            </div>
                        </label>
                    </li>
                ))}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>{t.common.cancel}</Button>
                <Button
                    type="button"
                    disabled={saving || count === 0}
                    loading={saving}
                    onClick={() => onSave(items.filter((_, index) => selected[index]))}
                >
                    {t.importFlow.saveSelected.replace("{count}", String(count))}
                </Button>
            </div>
            {count === 0 && <p className="text-right text-xs text-muted-foreground">{t.importFlow.emptySelection}</p>}
        </div>
    );
}
