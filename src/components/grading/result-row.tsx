"use client";

import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import type { GradingResultDetail, GradingVerdict } from "@/types/grading";

interface ResultRowProps {
    result: GradingResultDetail;
    disabled: boolean;
    onOverride: (override: { verdict?: GradingVerdict; score?: number }) => void;
}

const VERDICT_STYLE: Record<GradingVerdict, string> = {
    correct: "border-emerald-500/50 bg-emerald-500/5",
    partial: "border-amber-500/50 bg-amber-500/5",
    wrong: "border-red-500/50 bg-red-500/5",
    blank: "border-red-500/50 bg-red-500/5",
};

/** 一道题的判分：学生作答、答案、AI 理由，一键判对/判错，主观题可直接改分 */
export function ResultRow({ result, disabled, onOverride }: ResultRowProps) {
    const { t } = useLanguage();
    const { question } = result;
    return (
        <div className={cn("space-y-1.5 rounded-xl border p-3", VERDICT_STYLE[result.verdict])}>
            <div className="flex items-center gap-2">
                <span className="font-mono font-semibold">{question.number}</span>
                <span className="text-xs text-muted-foreground">{t.grading.verdict[result.verdict]}{result.source === "teacher" ? ` · ${t.grading.sourceTeacher}` : ""}</span>
                <span className="ml-auto text-sm font-semibold">{result.score}/{question.maxScore}</span>
            </div>
            <div className="grid gap-1 text-sm sm:grid-cols-2">
                <div><span className="text-muted-foreground">{t.grading.studentAnswer}：</span><span className="whitespace-pre-wrap break-words">{result.studentAnswer || "—"}</span></div>
                <div><span className="text-muted-foreground">{t.grading.keyAnswer}：</span><span className="whitespace-pre-wrap break-words">{question.answer || "—"}</span></div>
            </div>
            {result.reason && <p className="text-xs text-muted-foreground">{t.grading.aiReason}：{result.reason}</p>}
            <div className="flex items-center gap-2">
                <Button size="sm" variant={result.verdict === "correct" ? "default" : "outline"} disabled={disabled} onClick={() => onOverride({ verdict: "correct" })}>
                    <Check className="h-4 w-4" />{t.grading.markCorrect}
                </Button>
                <Button size="sm" variant={result.verdict === "wrong" || result.verdict === "blank" ? "destructive" : "outline"} disabled={disabled} onClick={() => onOverride({ verdict: "wrong" })}>
                    <X className="h-4 w-4" />{t.grading.markWrong}
                </Button>
                {question.type === "subjective" && (
                    <Input type="number" aria-label={t.grading.setScore} className="ml-auto h-8 w-20" min={0} max={question.maxScore} step={0.5}
                        defaultValue={result.score} disabled={disabled} key={`${result.id}-${result.score}`}
                        onBlur={(event) => {
                            const score = Number(event.target.value);
                            if (Number.isFinite(score) && score !== result.score) onOverride({ score });
                        }} />
                )}
            </div>
        </div>
    );
}
