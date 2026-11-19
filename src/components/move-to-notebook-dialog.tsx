"use client";

import { useState } from "react";
import { NotebookSelector } from "@/components/notebook-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";

interface MoveToNotebookDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    count: number;
    /** 当前所在错题本；选同一个时不能移动 */
    currentSubjectId?: string | null;
    moving: boolean;
    onMove: (subjectId: string) => void;
}

/**
 * 批量移动错题到另一个错题本。
 * Ported from margrop/wrong-notebook 1c3f25cf (MIT).
 */
export function MoveToNotebookDialog({ open, onOpenChange, count, currentSubjectId, moving, onMove }: MoveToNotebookDialogProps) {
    const { t } = useLanguage();
    const [target, setTarget] = useState<string>("");
    // 切换当前错题本时避免沿用与当前错题本相同的目标值
    const effectiveTarget = target && target !== currentSubjectId ? target : "";
    const disabled = !effectiveTarget || count === 0;

    const handleOpenChange = (next: boolean) => {
        if (moving) return;
        if (!next) setTarget("");
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent data-testid="move-to-notebook-dialog">
                <DialogHeader>
                    <DialogTitle>{t.notebook.moveTitle.replace("{count}", String(count))}</DialogTitle>
                    <DialogDescription>{t.notebook.moveDescription}</DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    <Label>{t.notebook.moveTarget}</Label>
                    <NotebookSelector value={effectiveTarget || undefined} onChange={setTarget} className="w-full" />
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={moving}>
                        {t.common.cancel}
                    </Button>
                    <Button type="button" onClick={() => onMove(effectiveTarget)} disabled={disabled} loading={moving}>
                        {t.notebook.moveConfirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
