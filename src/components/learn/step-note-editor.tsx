"use client";

import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";

export interface StepNoteEditorProps {
    note: string | null | undefined;
    onSave: (note: string | null) => Promise<void> | void;
}

/**
 * 学习路径单步批注编辑器：打通原先只读的 LearningPathStep.teacherNote 前端录入能力。
 */
export function StepNoteEditor({ note, onSave }: StepNoteEditorProps) {
    const { t } = useLanguage();
    const pe = t.grading.processEval;
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(note ?? "");

    if (!editing) {
        return (
            <div className="flex flex-wrap items-center gap-2 text-sm">
                {note && <span className="text-muted-foreground">{t.learn.teacherNote}：{note}</span>}
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={() => {
                        setDraft(note ?? "");
                        setEditing(true);
                    }}
                >
                    <MessageSquarePlus className="mr-1 h-3.5 w-3.5" />
                    {pe.editStepNote}
                </Button>
            </div>
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-2 pt-1">
            <Input
                value={draft}
                maxLength={300}
                placeholder={pe.stepNotePlaceholder}
                onChange={(e) => setDraft(e.target.value)}
                className="h-8 max-w-md text-xs"
            />
            <Button
                type="button"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                    void onSave(draft.trim() || null);
                    setEditing(false);
                }}
            >
                {t.common.save}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditing(false)}>
                {t.common.cancel}
            </Button>
        </div>
    );
}
