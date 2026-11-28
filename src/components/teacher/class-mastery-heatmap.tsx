"use client";

import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ProcessLevel } from "@/lib/ai/exam-paper-read";
import type { ClassMasteryMatrix } from "@/lib/class-mastery-matrix";
import { cn } from "@/lib/utils";

function cellClass(score: number | null): string {
    if (score === null) return "bg-muted/40 text-muted-foreground";
    if (score < 0.5) return "bg-rose-500/15 text-rose-700 dark:text-rose-300 font-semibold";
    if (score < 0.8) return "bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium";
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-medium";
}

export function ClassMasteryHeatmap({
    classId,
    matrix,
}: {
    classId: string;
    matrix: ClassMasteryMatrix;
}) {
    const { t } = useLanguage();
    const copy = t.classHeatmap;
    const levelLabels = t.grading.processEval.levels;

    if (matrix.knowledgePoints.length === 0 || matrix.rows.length === 0) {
        return <p className="text-sm text-muted-foreground">{copy.empty}</p>;
    }

    const formatHabit = (lvl: string | null) =>
        lvl && lvl in levelLabels ? levelLabels[lvl as ProcessLevel] : "—";

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-xs bg-rose-500/40" />
                    {copy.legendLow}
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-xs bg-amber-500/40" />
                    {copy.legendMid}
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-xs bg-emerald-500/40" />
                    {copy.legendHigh}
                </span>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-border bg-card">
                <table className="w-full border-collapse text-xs">
                    <thead>
                        <tr className="border-b border-border bg-muted/40">
                            <th className="sticky left-0 z-10 bg-muted/95 px-3 py-2.5 text-left font-semibold backdrop-blur-xs">
                                {copy.studentCol}
                            </th>
                            {matrix.knowledgePoints.map((kp) => (
                                <th key={kp} className="min-w-24 px-2.5 py-2.5 text-center font-medium">
                                    <Link
                                        href={`/variants?tab=weakness&classId=${encodeURIComponent(classId)}&topic=${encodeURIComponent(kp)}`}
                                        className="line-clamp-2 hover:text-primary hover:underline"
                                        title={kp}
                                    >
                                        {kp}
                                    </Link>
                                </th>
                            ))}
                            <th className="min-w-24 px-3 py-2.5 text-center font-medium">
                                {copy.habitsCol}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                        {matrix.rows.map((row) => (
                            <tr key={row.studentId} className="hover:bg-accent/30">
                                <td className="sticky left-0 z-10 bg-card/95 px-3 py-2 font-medium whitespace-nowrap backdrop-blur-xs">
                                    <Link
                                        href={`/teacher/students/${row.studentId}`}
                                        className="hover:text-primary hover:underline"
                                    >
                                        {row.name}
                                    </Link>
                                    {row.studentNo && (
                                        <span className="ml-1.5 text-[11px] text-muted-foreground">{row.studentNo}</span>
                                    )}
                                </td>
                                {row.cells.map((score, idx) => (
                                    <td key={idx} className="p-1.5 text-center">
                                        <span
                                            className={cn(
                                                "inline-block min-w-12 rounded-md px-2 py-1 text-center tabular-nums",
                                                cellClass(score),
                                            )}
                                        >
                                            {score === null ? "—" : `${Math.round(score * 100)}%`}
                                        </span>
                                    </td>
                                ))}
                                <td className="px-3 py-2 text-center text-[11px] text-muted-foreground whitespace-nowrap">
                                    {formatHabit(row.handwritingLevel)} / {formatHabit(row.attitudeLevel)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
