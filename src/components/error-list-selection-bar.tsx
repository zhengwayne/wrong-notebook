"use client";

import { Trash2, X } from "lucide-react";
import { QuestionSimilarityDialog } from "@/components/question-similarity-dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

export interface ErrorListSelectionBarProps {
    selectedIds: string[];
    deleting: boolean;
    onCancel: () => void;
    onDelete: () => void;
}

export function ErrorListSelectionBar({
    selectedIds,
    deleting,
    onCancel,
    onDelete,
}: ErrorListSelectionBarProps) {
    const { t } = useLanguage();
    return (
        <div
            role="region"
            aria-label={t.notebook.selectMode}
            className="surface-paper pb-safe fixed inset-x-0 bottom-0 z-50 border-t bg-card/95 p-4 backdrop-blur"
        >
            <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5 text-sm text-muted-foreground" aria-live="polite">
                    <p className="font-medium text-foreground">
                        {t.notebook.selectedCount.replace("{count}", String(selectedIds.length))}
                    </p>
                    <p className="text-xs">{t.questionSimilarity.selectTwo}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <QuestionSimilarityDialog ids={selectedIds} />
                    <Button type="button" variant="outline" onClick={onCancel} disabled={deleting}>
                        <X className="h-4 w-4" aria-hidden="true" />
                        {t.notebook.cancelSelect}
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        loading={deleting}
                        onClick={onDelete}
                        disabled={selectedIds.length === 0}
                    >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        {t.notebook.deleteSelected}
                    </Button>
                </div>
            </div>
        </div>
    );
}
