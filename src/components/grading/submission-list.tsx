"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import type { GradingStudentInfo, GradingSubmissionBrief } from "@/types/grading";

interface SubmissionListProps {
    taskId: string;
    students: GradingStudentInfo[];
    submissions: GradingSubmissionBrief[];
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    pending: "outline", grading: "outline", graded: "default", failed: "destructive", confirmed: "secondary",
};

/** 答卷列表：状态、学生、得分，并列出未交卷的学生 */
export function SubmissionList({ taskId, students, submissions }: SubmissionListProps) {
    const { t } = useLanguage();
    const names = new Map(students.map((student) => [student.id, student.name]));
    const submitted = new Set(submissions.map((submission) => submission.studentId).filter(Boolean));
    const missing = students.filter((student) => !submitted.has(student.id)).map((student) => student.name);

    return (
        <div className="space-y-3">
            {missing.length > 0 && submissions.length > 0 && (
                <p className="text-sm text-muted-foreground">{t.grading.missing.replace("{names}", missing.join("、"))}</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {submissions.map((submission, index) => (
                    <Link key={submission.id} href={`/grading/${taskId}/submissions/${submission.id}`}
                        className="flex items-center justify-between gap-2 rounded-xl border p-3 transition-colors hover:border-primary/50">
                        <div className="min-w-0">
                            <div className="truncate font-medium">
                                {submission.studentId ? names.get(submission.studentId) : t.grading.unassigned}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                                {t.grading.paperN.replace("{index}", String(index + 1))} · {t.grading.pageCount.replace("{count}", String(submission.pageCount))}
                                {!submission.studentId && submission.detectedName ? ` · ${t.grading.detected.replace("{name}", submission.detectedName)}` : ""}
                            </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge variant={STATUS_VARIANT[submission.status] || "outline"}>{t.grading.status[submission.status]}</Badge>
                            {submission.totalScore !== null && <span className="text-sm font-semibold">{submission.totalScore}</span>}
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
