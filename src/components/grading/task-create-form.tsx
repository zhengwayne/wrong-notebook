"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, CheckCircle2, AlertCircle, FileText, Keyboard, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { ApiError, apiClient } from "@/lib/api-client";
import type { AiReadinessSummary } from "@/lib/ai-readiness";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import type { ScoringMode } from "@/lib/grading-grades";
import type { ExamPaperSummary } from "@/types/api";
import type { GradingClassInfo } from "@/types/grading";

type KeySource = "ai_auto" | "quick" | "exam" | "photo";

interface TaskCreateFormProps {
    classes: GradingClassInfo[];
}

/** 新建改卷任务：支持免名册/免预录答案的「随堂速批」以及数值分/等级制切换 */
export function TaskCreateForm({ classes }: TaskCreateFormProps) {
    const { t } = useLanguage();
    const router = useRouter();
    const [title, setTitle] = useState("");
    const [classId, setClassId] = useState(classes[0]?.id || "");
    const [extraClassIds, setExtraClassIds] = useState<string[]>([]);
    const [subjectName, setSubjectName] = useState("数学");
    const [source, setSource] = useState<KeySource>(classes.length === 0 ? "ai_auto" : "quick");
    const [scoringMode, setScoringMode] = useState<ScoringMode>("numeric");
    const [keyText, setKeyText] = useState("");
    const [defaultScore, setDefaultScore] = useState(2);
    const [exams, setExams] = useState<ExamPaperSummary[]>([]);
    const [examPaperId, setExamPaperId] = useState("");
    const [aiReadiness, setAiReadiness] = useState<AiReadinessSummary | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        apiClient.get<ExamPaperSummary[]>("/api/exams").then(setExams).catch(() => setExams([]));
        apiClient.get<{ aiReadiness?: AiReadinessSummary }>("/api/settings")
            .then((res) => setAiReadiness(res.aiReadiness ?? null))
            .catch(() => setAiReadiness(null));
    }, []);

    const isQuickAuto = source === "ai_auto";
    const qg = t.grading.quickGrading;

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        setSubmitting(true);
        setError(null);
        try {
            const body = {
                title,
                ...(classId ? { classId } : {}),
                taskMode: isQuickAuto ? "quick" : "standard",
                scoringMode,
                subjectName,
                defaultScore,
                extraClassIds: classId ? extraClassIds.filter((id) => id !== classId) : [],
                ...(source === "quick" && keyText.trim() ? { keyText } : {}),
                ...(source === "exam" && examPaperId ? { examPaperId } : {}),
            };
            const task = await apiClient.post<{ id: string }>("/api/grading/tasks", body);
            router.push(`/grading/${task.id}?tab=${source === "photo" ? "key" : "capture"}`);
        } catch (err) {
            const lines = err instanceof ApiError ? (err.data as { details?: { lines?: number[] } })?.details?.lines : undefined;
            setError(lines?.length
                ? t.grading.invalidKeyLines.replace("{lines}", lines.join(", "))
                : t.grading.createFailed.replace("{error}", getApiErrorMessage(err) || getErrorMessage(err)));
            setSubmitting(false);
        }
    };

    const canSubmit = Boolean(title.trim()) && (Boolean(classId) || isQuickAuto) && (source !== "exam" || Boolean(examPaperId));

    return (
        <Card className="rounded-2xl">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-lg">{t.grading.create}</CardTitle>
                {aiReadiness && (
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${aiReadiness.ready ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                        {aiReadiness.ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                        {aiReadiness.ready ? qg.aiReady : qg.aiNotReady}
                    </span>
                )}
            </CardHeader>
            <CardContent>
                <form className="space-y-4" onSubmit={submit}>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-1.5 sm:col-span-3">
                            <Label htmlFor="grading-title">{t.grading.taskTitle}</Label>
                            <Input id="grading-title" required value={title} placeholder={t.grading.taskTitlePlaceholder} onChange={(event) => setTitle(event.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="grading-class">{t.grading.classLabel}</Label>
                            <NativeSelect id="grading-class" value={classId} onChange={(event) => setClassId(event.target.value)}>
                                {classes.length === 0 || isQuickAuto ? (
                                    <option value="">{qg.autoCreateClassOption}</option>
                                ) : null}
                                {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                            </NativeSelect>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="grading-subject">{t.grading.subject}</Label>
                            <Input id="grading-subject" value={subjectName} onChange={(event) => setSubjectName(event.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="grading-scoring-mode">{qg.scoringModeLabel}</Label>
                            <NativeSelect id="grading-scoring-mode" value={scoringMode} onChange={(e) => setScoringMode(e.target.value as ScoringMode)}>
                                <option value="numeric">{qg.scoringNumeric}</option>
                                <option value="grade">{qg.scoringGrade}</option>
                            </NativeSelect>
                        </div>
                        {classes.length > 1 && classId && (
                            <fieldset className="space-y-1.5 sm:col-span-3">
                                <legend className="text-sm font-medium">{t.grading.extraClasses}</legend>
                                <p className="text-xs text-muted-foreground">{t.grading.extraClassesHint}</p>
                                <div className="flex flex-wrap gap-2">
                                    {classes.filter((item) => item.id !== classId).map((item) => (
                                        <label key={item.id} className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
                                            <input type="checkbox" checked={extraClassIds.includes(item.id)}
                                                onChange={(event) => setExtraClassIds((prev) => event.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id))} />
                                            {item.name}
                                        </label>
                                    ))}
                                </div>
                            </fieldset>
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label>{t.grading.keySource}</Label>
                        <SegmentedControl<KeySource> value={source} onChange={setSource} options={[
                            { value: "ai_auto", label: qg.keyAiAuto, icon: Zap },
                            { value: "quick", label: t.grading.keyQuick, icon: Keyboard },
                            { value: "exam", label: t.grading.keyExam, icon: FileText },
                            { value: "photo", label: t.grading.keyPhoto, icon: Camera },
                        ]} />
                        {source === "ai_auto" && (
                            <p className="rounded-lg border bg-muted/40 p-2.5 text-xs text-muted-foreground">{qg.keyAiAutoHint}</p>
                        )}
                        {source === "quick" && (
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground">{t.grading.keyQuickHint}</p>
                                <Textarea rows={5} value={keyText} aria-label={t.grading.keyQuick} placeholder={"1-10 ABCDABCDAB\n11 x=2 4\n12 主观 10 列方程 4 分，求解 4 分，作答 2 分"}
                                    onChange={(event) => setKeyText(event.target.value)} className="font-mono" />
                                <div className="flex items-center gap-2">
                                    <Label htmlFor="grading-default-score" className="shrink-0">{t.grading.defaultScore}</Label>
                                    <Input id="grading-default-score" type="number" min={0} step={0.5} className="w-24" value={defaultScore}
                                        onChange={(event) => setDefaultScore(Number(event.target.value) || 0)} />
                                </div>
                            </div>
                        )}
                        {source === "exam" && (
                            <NativeSelect aria-label={t.grading.pickExam} value={examPaperId} onChange={(event) => setExamPaperId(event.target.value)}>
                                <option value="">{exams.length ? t.grading.pickExam : t.grading.noExams}</option>
                                {exams.map((exam) => <option key={exam.id} value={exam.id}>{exam.title}</option>)}
                            </NativeSelect>
                        )}
                        {source === "photo" && <p className="text-xs text-muted-foreground">{t.grading.keyPhotoHint}</p>}
                    </div>

                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <Button type="submit" disabled={submitting || !canSubmit}>
                        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                        {t.grading.createAndContinue}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
