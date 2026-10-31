"use client";

import { useState } from "react";
import Link from "next/link";
import { Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MatchPanel } from "@/components/grading/match-panel";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog, toast } from "@/lib/feedback";
import { studentLabel } from "@/lib/grading-labels";
import type { GradingStudentInfo, GradingSubmissionBrief } from "@/types/grading";

interface SubmissionListProps {
    taskId: string;
    students: GradingStudentInfo[];
    submissions: GradingSubmissionBrief[];
    multiClass: boolean;
    onChanged: () => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    pending: "outline", grading: "outline", graded: "default", failed: "destructive", confirmed: "secondary",
};

export function needsReview(submission: GradingSubmissionBrief): boolean {
    return submission.status !== "confirmed" && (!submission.studentId || submission.matchStatus === "review");
}

/** 答卷列表：先列出待确认的答卷（一键分配、并入上一份），再列出全部答卷与未交卷学生 */
export function SubmissionList({ taskId, students, submissions, multiClass, onChanged }: SubmissionListProps) {
    const { t, language } = useLanguage();
    const m = t.grading.match;
    const [busy, setBusy] = useState<string | null>(null);
    const byId = new Map(students.map((student) => [student.id, student]));
    const taken = new Set(submissions.map((submission) => submission.studentId).filter((id): id is string => !!id));
    const missing = students.filter((student) => !taken.has(student.id)).map((student) => studentLabel(student, multiClass));
    const review = submissions.filter(needsReview);

    const act = async (id: string, run: () => Promise<unknown>, success?: string) => {
        setBusy(id);
        try {
            await run();
            if (success) toast.success(success);
            onChanged();
        } catch (error) {
            toast.error(error);
        } finally {
            setBusy(null);
        }
    };

    const assign = (id: string, studentId: string) => act(id, () => apiClient.patch(`/api/grading/submissions/${id}`, { studentId }));

    const mergePrev = async (index: number) => {
        const source = submissions[index];
        const target = submissions[index - 1];
        if (!target || !(await confirmDialog(m.confirmMerge))) return;
        await act(source.id, () => apiClient.post(`/api/grading/submissions/${source.id}/merge`, { targetId: target.id, language }), m.merged);
    };

    return (
        <div className="space-y-4">
            {review.length > 0 && (
                <section className="space-y-2 rounded-2xl border border-amber-500/50 p-3">
                    <h3 className="font-semibold text-amber-700 dark:text-amber-400">{m.reviewTitle.replace("{count}", String(review.length))}</h3>
                    <p className="text-xs text-muted-foreground">{m.reviewHint}</p>
                    <div className="grid gap-2 md:grid-cols-2">
                        {review.map((submission) => {
                            const index = submissions.indexOf(submission);
                            const prev = submissions[index - 1];
                            return (
                                <div key={submission.id} className="space-y-2 rounded-xl border bg-background p-3">
                                    <div className="flex items-center justify-between gap-2 text-sm">
                                        <Link href={`/grading/${taskId}/submissions/${submission.id}`} className="font-medium hover:text-primary">
                                            {t.grading.paperN.replace("{index}", String(index + 1))} · {t.grading.pageCount.replace("{count}", String(submission.pageCount))}
                                        </Link>
                                        {prev && prev.status !== "confirmed" && (
                                            <Button size="sm" variant="outline" className="h-8" disabled={busy === submission.id || submission.status === "grading"} onClick={() => mergePrev(index)}>
                                                <Undo2 className="h-3.5 w-3.5" />{m.mergePrev}
                                            </Button>
                                        )}
                                    </div>
                                    <MatchPanel info={submission} studentId={submission.studentId} students={students} multiClass={multiClass}
                                        takenIds={taken} disabled={busy === submission.id} onAssign={(studentId) => assign(submission.id, studentId)} />
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}
            {missing.length > 0 && submissions.length > 0 && (
                <p className="text-sm text-muted-foreground">{t.grading.missing.replace("{names}", missing.join("、"))}</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {submissions.map((submission, index) => {
                    const student = submission.studentId ? byId.get(submission.studentId) : null;
                    return (
                        <Link key={submission.id} href={`/grading/${taskId}/submissions/${submission.id}`}
                            className="flex items-center justify-between gap-2 rounded-xl border p-3 transition-colors hover:border-primary/50">
                            <div className="min-w-0">
                                <div className="truncate font-medium">{student ? studentLabel(student, multiClass) : t.grading.unassigned}</div>
                                <div className="truncate text-xs text-muted-foreground">
                                    {t.grading.paperN.replace("{index}", String(index + 1))} · {t.grading.pageCount.replace("{count}", String(submission.pageCount))}
                                    {submission.matchStatus ? ` · ${m.status[needsReview(submission) ? "review" : submission.matchStatus]}` : ""}
                                </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                                <Badge variant={STATUS_VARIANT[submission.status] || "outline"}>{t.grading.status[submission.status]}</Badge>
                                {submission.totalScore !== null && <span className="text-sm font-semibold">{submission.totalScore}</span>}
                            </div>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}
