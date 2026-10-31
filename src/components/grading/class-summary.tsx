"use client";

import { useEffect, useState } from "react";
import { Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageLoading } from "@/components/ui/page-loading";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { GradingTaskSummaryStats } from "@/types/grading";

interface ClassSummaryProps {
    taskId: string;
    /** 变化时重新加载（答卷状态更新后） */
    version: string;
}

function rateColor(rate: number): string {
    if (rate >= 50) return "bg-red-500";
    if (rate >= 25) return "bg-amber-500";
    return "bg-emerald-500";
}

/** 班级汇总：分数概况、每题错误率、学生成绩与共性薄弱知识点，可导出 CSV 或打印 */
export function ClassSummary({ taskId, version }: ClassSummaryProps) {
    const { t, language } = useLanguage();
    const [summary, setSummary] = useState<GradingTaskSummaryStats | null>(null);

    useEffect(() => {
        apiClient.get<GradingTaskSummaryStats>(`/api/grading/tasks/${taskId}/summary`).then(setSummary).catch(() => setSummary(null));
    }, [taskId, version]);

    if (!summary) return <PageLoading />;
    if (summary.gradedCount === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{t.grading.summaryEmpty}</p>;

    const stats = [
        { label: t.grading.graded, value: summary.gradedCount },
        { label: t.grading.average, value: summary.averageScore },
        { label: t.grading.highest, value: summary.highestScore },
        { label: t.grading.lowest, value: summary.lowestScore },
    ];

    return (
        <div className="space-y-6 print:space-y-4">
            <div className="flex flex-wrap gap-2 print:hidden">
                <Button variant="outline" asChild>
                    <a href={`/api/grading/tasks/${taskId}/summary?format=csv&lang=${language}`}><Download className="h-4 w-4" />{t.grading.exportCsv}</a>
                </Button>
                <Button variant="outline" onClick={() => window.print()}><Printer className="h-4 w-4" />{t.grading.print}</Button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {stats.map((stat) => (
                    <div key={stat.label} className="rounded-xl border p-3 text-center">
                        <div className="text-2xl font-bold">{stat.value ?? "-"}</div>
                        <div className="text-xs text-muted-foreground">{stat.label}</div>
                    </div>
                ))}
            </div>
            <p className="text-sm text-muted-foreground">{t.grading.fullScore.replace("{score}", String(summary.fullScore))}</p>

            <section className="space-y-2">
                <h3 className="font-semibold">{t.grading.perQuestion}</h3>
                <div className="space-y-1.5">
                    {summary.questions.map((question) => (
                        <div key={question.id} className="flex items-center gap-2 text-sm">
                            <span className="w-12 shrink-0 text-right font-mono">{question.number}</span>
                            <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                                <div className={cn("h-full", rateColor(question.errorRate))} style={{ width: `${question.errorRate}%` }} />
                            </div>
                            <span className="w-24 shrink-0 text-xs text-muted-foreground">{question.errorRate}% ({question.wrong}/{question.answered})</span>
                        </div>
                    ))}
                </div>
            </section>

            {summary.weakPoints.length > 0 && (
                <section className="space-y-2">
                    <h3 className="font-semibold">{t.grading.weakPoints}</h3>
                    <div className="flex flex-wrap gap-2">
                        {summary.weakPoints.map((point) => (
                            <span key={point.name} className="rounded-full border px-3 py-1 text-sm">
                                {point.name} <span className="text-muted-foreground">{point.errorRate}%</span>
                            </span>
                        ))}
                    </div>
                </section>
            )}

            <section className="space-y-2">
                <h3 className="font-semibold">{t.grading.perStudent}</h3>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b text-left text-muted-foreground">
                            <th className="py-1.5">{t.grading.student}</th>
                            <th className="py-1.5">{t.grading.score}</th>
                            <th className="py-1.5">{t.grading.wrongQuestions}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {summary.students.map((student) => (
                            <tr key={student.submissionId} className="border-b last:border-0">
                                <td className="py-1.5">{student.name || t.grading.unassigned}</td>
                                <td className="py-1.5 font-semibold">{student.score ?? "-"}</td>
                                <td className="py-1.5 text-muted-foreground">{student.wrongNumbers.join(", ")}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
