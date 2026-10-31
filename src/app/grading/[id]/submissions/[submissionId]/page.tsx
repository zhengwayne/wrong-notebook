"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { NativeSelect } from "@/components/grading/native-select";
import { ResultRow } from "@/components/grading/result-row";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog, toast } from "@/lib/feedback";
import { usePageTitle } from "@/lib/page-title";
import type { GradingSubmissionDetail, GradingTaskDetail, GradingVerdict } from "@/types/grading";

export default function GradingReviewPage() {
    const { id, submissionId } = useParams<{ id: string; submissionId: string }>();
    const router = useRouter();
    const { t, language } = useLanguage();
    usePageTitle(t.grading.reviewTitle);
    const [submission, setSubmission] = useState<GradingSubmissionDetail | null>(null);
    const [task, setTask] = useState<GradingTaskDetail | null>(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(() => {
        apiClient.get<GradingSubmissionDetail>(`/api/grading/submissions/${submissionId}`).then(setSubmission).catch(() => router.replace(`/grading/${id}`));
        apiClient.get<GradingTaskDetail>(`/api/grading/tasks/${id}`).then(setTask).catch(() => undefined);
    }, [id, submissionId, router]);

     
    useEffect(() => { load(); }, [load]);

    const grading = submission?.status === "pending" || submission?.status === "grading";
    useEffect(() => {
        if (!grading) return;
        const timer = setInterval(load, 3000);
        return () => clearInterval(timer);
    }, [grading, load]);

    if (!submission || !task) return <PageLoading />;
    const confirmed = submission.status === "confirmed";

    const patch = async (body: { studentId?: string | null; results?: { id: string; verdict?: GradingVerdict; score?: number }[] }) => {
        try {
            setSubmission(await apiClient.patch<GradingSubmissionDetail>(`/api/grading/submissions/${submissionId}`, body));
        } catch (error) {
            toast.error(error);
        }
    };

    // 下一份待复核的答卷
    const queue = task.submissions.filter((item) => item.status === "graded" && item.id !== submissionId);
    const goNext = () => router.push(queue[0] ? `/grading/${id}/submissions/${queue[0].id}` : `/grading/${id}?tab=papers`);

    const confirm = async () => {
        if (!submission.studentId) {
            toast.warning(t.grading.needStudent);
            return;
        }
        setSaving(true);
        try {
            const result = await apiClient.post<{ importedCount: number }>(`/api/grading/submissions/${submissionId}/confirm`, {});
            const name = task.students.find((student) => student.id === submission.studentId)?.name || "";
            toast.success(t.grading.confirmed.replace("{count}", String(result.importedCount)).replace("{name}", name));
            goNext();
        } catch (error) {
            toast.error(error);
            setSaving(false);
        }
    };

    const regrade = async () => {
        await apiClient.post(`/api/grading/submissions/${submissionId}/regrade`, { language });
        load();
    };

    const remove = async () => {
        if (!(await confirmDialog(t.grading.confirmDeletePaper, { destructive: true }))) return;
        await apiClient.delete(`/api/grading/submissions/${submissionId}`);
        router.replace(`/grading/${id}?tab=papers`);
    };

    return (
        <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-4">
                <PageHeader backHref={`/grading/${id}?tab=papers`} title={t.grading.reviewTitle} description={submission.taskTitle}
                    actions={<Button variant="ghost" size="icon" aria-label={t.grading.deletePaper} onClick={remove}><Trash2 className="h-4 w-4" /></Button>} />
                <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-2">
                        {submission.images.map((image, index) => (
                            <a key={index} href={image} target="_blank" rel="noreferrer">
                                { }
                                <img src={image} alt={t.grading.paperN.replace("{index}", String(index + 1))} className="w-full rounded-xl border" />
                            </a>
                        ))}
                    </div>
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <NativeSelect aria-label={t.grading.student} className="flex-1" value={submission.studentId || ""} disabled={confirmed}
                                onChange={(event) => patch({ studentId: event.target.value || null })}>
                                <option value="">{t.grading.unassigned}</option>
                                {task.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
                            </NativeSelect>
                            {submission.totalScore !== null && <span className="text-2xl font-bold">{submission.totalScore}</span>}
                        </div>
                        {submission.detectedName && <p className="text-xs text-muted-foreground">{t.grading.detected.replace("{name}", submission.detectedName)}</p>}
                        {grading && <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />{t.grading.gradingInProgress}</p>}
                        {submission.status === "failed" && <p className="text-sm text-destructive">{t.grading.gradingFailed.replace("{error}", submission.error || "")}</p>}
                        {submission.results.map((result) => (
                            <ResultRow key={result.id} result={result} disabled={confirmed}
                                onOverride={(override) => patch({ results: [{ id: result.id, ...override }] })} />
                        ))}
                        <div className="sticky bottom-20 flex flex-wrap gap-2 rounded-xl bg-background/95 py-2 md:bottom-2">
                            {!confirmed && submission.results.length > 0 && (
                                <Button size="lg" className="flex-1" onClick={confirm} disabled={saving}>
                                    {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
                                    {saving ? t.grading.confirming : t.grading.confirm}
                                </Button>
                            )}
                            {!confirmed && !grading && (
                                <Button size="lg" variant="outline" onClick={regrade}><RotateCcw className="h-5 w-5" />{t.grading.regrade}</Button>
                            )}
                            {confirmed && <Button size="lg" variant="outline" asChild><Link href={queue[0] ? `/grading/${id}/submissions/${queue[0].id}` : `/grading/${id}?tab=summary`}>{t.grading.nextToReview}</Link></Button>}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
