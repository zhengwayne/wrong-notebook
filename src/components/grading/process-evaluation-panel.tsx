"use client";

import { useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { PROCESS_LEVELS, type ProcessLevel, type VisualAlertKind } from "@/lib/ai/exam-paper-read";
import {
    getProcessCapsules,
    PROCESS_CAPSULE_KEYS,
    synthesizeTeacherComment,
} from "@/lib/process-evaluation";

export interface ProcessEvaluationValue {
    handwritingLevel: ProcessLevel | null;
    neatnessLevel: ProcessLevel | null;
    attitudeLevel: ProcessLevel | null;
    processTags: string[];
    teacherComment: string | null;
}

export interface ProcessEvaluationPanelProps {
    value: ProcessEvaluationValue;
    visualAlerts?: string[];
    disabled?: boolean;
    onSave: (next: ProcessEvaluationValue) => Promise<void> | void;
}

/**
 * 写字工整度、卷面整洁度、学习态度三维评价与 1 秒零打字评语胶囊组件。
 */
export function ProcessEvaluationPanel({
    value,
    visualAlerts = [],
    disabled = false,
    onSave,
}: ProcessEvaluationPanelProps) {
    const { t, language } = useLanguage();
    const pe = t.grading.processEval;
    const capsules = getProcessCapsules(language);
    const [commentDraft, setCommentDraft] = useState(value.teacherComment ?? "");

    const applyUpdate = (patch: Partial<ProcessEvaluationValue>) => {
        const merged: ProcessEvaluationValue = {
            handwritingLevel: patch.handwritingLevel !== undefined ? patch.handwritingLevel : value.handwritingLevel,
            neatnessLevel: patch.neatnessLevel !== undefined ? patch.neatnessLevel : value.neatnessLevel,
            attitudeLevel: patch.attitudeLevel !== undefined ? patch.attitudeLevel : value.attitudeLevel,
            processTags: patch.processTags !== undefined ? patch.processTags : value.processTags,
            teacherComment: commentDraft,
        };
        const synthesized = synthesizeTeacherComment(
            {
                handwritingLevel: merged.handwritingLevel,
                neatnessLevel: merged.neatnessLevel,
                attitudeLevel: merged.attitudeLevel,
                capsuleKeys: merged.processTags,
            },
            language,
        );
        setCommentDraft(synthesized);
        void onSave({ ...merged, teacherComment: synthesized || null });
    };

    const toggleCapsule = (key: string) => {
        const exists = value.processTags.includes(key);
        const nextTags = exists ? value.processTags.filter((k) => k !== key) : [...value.processTags, key];
        applyUpdate({ processTags: nextTags });
    };

    const dimensions: Array<{ field: "handwritingLevel" | "neatnessLevel" | "attitudeLevel"; label: string }> = [
        { field: "handwritingLevel", label: pe.handwriting },
        { field: "neatnessLevel", label: pe.neatness },
        { field: "attitudeLevel", label: pe.attitude },
    ];

    return (
        <section className="space-y-3 rounded-2xl border bg-card p-3.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 font-semibold">
                    <Sparkles className="h-4 w-4 text-primary" />
                    {pe.title}
                </h3>
                {visualAlerts.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {visualAlerts.map((alert) => {
                            const text = pe.alerts[alert as VisualAlertKind];
                            if (!text) return null;
                            return (
                                <span key={alert} className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                                    <AlertTriangle className="h-3 w-3" />
                                    {text}
                                </span>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="space-y-1.5">
                {dimensions.map(({ field, label }) => {
                    const current = value[field];
                    return (
                        <div key={field} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-1.5">
                            <span className="text-xs font-medium">{label}</span>
                            <div className="flex flex-wrap gap-1">
                                {PROCESS_LEVELS.map((lv) => (
                                    <button
                                        key={lv}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => applyUpdate({ [field]: current === lv ? null : lv })}
                                        className={`rounded px-2 py-0.5 text-xs transition ${
                                            current === lv
                                                ? "bg-primary font-semibold text-primary-foreground"
                                                : "bg-muted text-muted-foreground hover:text-foreground"
                                        }`}
                                    >
                                        {pe.levels[lv]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">{pe.capsulesLabel}</div>
                <div className="flex flex-wrap gap-1.5">
                    {PROCESS_CAPSULE_KEYS.map((key) => {
                        const active = value.processTags.includes(key);
                        return (
                            <button
                                key={key}
                                type="button"
                                disabled={disabled}
                                onClick={() => toggleCapsule(key)}
                                className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                                    active
                                        ? "border-primary bg-primary text-primary-foreground font-medium"
                                        : "bg-background hover:border-primary/60"
                                }`}
                            >
                                {active ? "✓ " : "+ "}{capsules[key].label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="space-y-1.5">
                <Textarea
                    rows={2}
                    disabled={disabled}
                    value={commentDraft}
                    placeholder={pe.commentPlaceholder}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    className="text-xs"
                />
                {!disabled && commentDraft !== (value.teacherComment ?? "") && (
                    <div className="flex justify-end">
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => onSave({ ...value, teacherComment: commentDraft.trim() || null })}
                        >
                            {pe.saveComment}
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}
