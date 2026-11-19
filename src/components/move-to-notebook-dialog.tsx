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
    const disabled = !target || target === currentSubjectId || count === 0;

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!moving) onOpenChange(next); }}>
            <DialogContent data-testid="move-to-notebook-dialog">
                <DialogHeader>
                    <DialogTitle>{t.notebook.moveTitle.replace("{count}", String(count))}</DialogTitle>
                    <DialogDescription>{t.notebook.moveDescription}</DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    <Label>{t.notebook.moveTarget}</Label>
                    <NotebookSelector value={target || undefined} onChange={setTarget} className="w-full" />
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={moving}>
                        {t.common.cancel}
                    </Button>
                    <Button type="button" onClick={() => onMove(target)} disabled={disabled} loading={moving}>
                        {t.notebook.moveConfirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
