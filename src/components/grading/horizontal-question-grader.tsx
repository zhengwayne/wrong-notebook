"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import type { KeyQuestion } from "@/types/grading";

interface QuestionStripItem {
    resultId: string;
    submissionId: string;
    submissionStatus: string;
    studentName: string | null;
    studentNo: string | null;
    studentAnswer: string | null;
    verdict: string;
    score: number;
    aiScore: number | null;
    reason: string | null;
    comment: string | null;
    bbox: { pageIndex: number; x: number; y: number; width: number; height: number } | null;
    pageImageUrl: string;
}

export interface HorizontalQuestionGraderProps {
    taskId: string;
    questions: KeyQuestion[];
    onChanged: () => void;
}

function quickScoreSteps(maxScore: number): number[] {
    if (maxScore <= 2) return [0, Math.round(maxScore) / 2, maxScore];
    const half = Math.round(maxScore) / 2;
    const high = Math.round(maxScore * 0.8 * 2) / 2;
    return Array.from(new Set([0, half, high, maxScore])).sort((a, b) => b - a);
}

/**
 * 按题号横向切题流阅卷台：锁死单道题目，平铺全班学生的手写区域与转写内容，支持一气呵成统一尺度赋分。
 */
export function HorizontalQuestionGrader({ taskId, questions, onChanged }: HorizontalQuestionGraderProps) {
    const { t } = useLanguage();
    const defaultQuestion = questions.find((q) => q.type === "subjective") ?? questions[0] ?? null;
    const [questionId, setQuestionId] = useState(defaultQuestion?.id ?? "");
    const [strips, setStrips] = useState<QuestionStripItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);

    const activeQuestion = questions.find((q) => q.id === questionId) ?? defaultQuestion;

    useEffect(() => {
        const qid = activeQuestion?.id;
        if (!qid) return;
        let cancelled = false;
        apiClient.get<{ strips: QuestionStripItem[] }>(
            `/api/grading/tasks/${taskId}/questions/${qid}/strips`,
        )
            .then((res) => {
                if (!cancelled) {
                    setStrips(res.strips);
                    setLoading(false);
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    toast.error(error);
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [activeQuestion?.id, taskId]);

    const handleQuestionChange = useCallback((nextId: string) => {
        setLoading(true);
        setQuestionId(nextId);
    }, []);

    if (!activeQuestion) {
        return <p className="text-sm text-muted-foreground">{t.grading.noKey}</p>;
    }

    const handleScore = async (strip: QuestionStripItem, score: number) => {
        setSavingId(strip.resultId);
        try {
            await apiClient.patch(`/api/grading/tasks/${taskId}/questions/${activeQuestion.id}/strips`, {
                updates: [{ resultId: strip.resultId, score }],
            });
            setStrips((prev) => prev.map((item) => (
                item.resultId === strip.resultId ? { ...item, score } : item
            )));
            onChanged();
        } catch (error) {
            toast.error(error);
        } finally {
            setSavingId(null);
        }
    };

    const steps = quickScoreSteps(activeQuestion.maxScore);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t.grading.quickGrading.horizontalTab}：</span>
                    <NativeSelect value={activeQuestion.id} onChange={(e) => handleQuestionChange(e.target.value)}>
                        {questions.map((q) => (
                            <option key={q.id} value={q.id}>
                                #{q.number} ({q.type === "subjective" ? "主观" : "客观"} · {q.maxScore})
                            </option>
                        ))}
                    </NativeSelect>
                </div>
                {activeQuestion.answer && (
                    <span className="truncate text-xs text-muted-foreground max-w-md">
                        参考答案：{activeQuestion.answer}
                    </span>
                )}
            </div>

            {loading ? (
                <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {strips.map((strip) => {
                        const locked = strip.submissionStatus === "confirmed";
                        return (
                            <Card key={strip.resultId} className="rounded-xl">
                                <CardContent className="space-y-2.5 pt-4 text-sm">
                                    <div className="flex items-center justify-between">
                                        <span className="font-semibold">
                                            {strip.studentNo ? `${strip.studentNo} · ` : ""}{strip.studentName || t.grading.unassigned}
                                        </span>
                                        <span className="font-mono font-bold text-primary">
                                            {strip.score} / {activeQuestion.maxScore}
                                        </span>
                                    </div>
                                    {strip.pageImageUrl && (
                                        <div className="max-h-36 overflow-hidden rounded-lg border bg-muted/20">
                                            <img
                                                src={strip.pageImageUrl}
                                                alt={`#${activeQuestion.number}`}
                                                className="w-full object-cover"
                                                style={strip.bbox ? {
                                                    objectPosition: `center ${Math.round((strip.bbox.y + strip.bbox.height / 2) * 100)}%`,
                                                } : undefined}
                                            />
                                        </div>
                                    )}
                                    <div className="rounded bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
                                        {strip.studentAnswer || "（空白未作答）"}
                                    </div>
                                    {strip.reason && <p className="text-xs text-muted-foreground">{strip.reason}</p>}
                                    <div className="flex flex-wrap gap-1.5">
                                        {steps.map((val) => (
                                            <Button
                                                key={val}
                                                type="button"
                                                size="sm"
                                                variant={strip.score === val ? "default" : "outline"}
                                                disabled={locked || savingId === strip.resultId}
                                                onClick={() => handleScore(strip, val)}
                                                className="h-7 px-2.5 font-mono text-xs"
                                            >
                                                {val}
                                            </Button>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
