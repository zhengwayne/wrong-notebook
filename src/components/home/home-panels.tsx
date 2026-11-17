"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export function scoreLabel(score: number) {
    return `${Math.round(score * 100)}%`;
}

export function MasteryList({
    items,
    empty,
}: {
    items: Array<{ knowledgePoint: string; score: number; evidenceCount?: number }>;
    empty: string;
}) {
    const { t } = useLanguage();
    if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <ul className="space-y-2">
            {items.slice(0, 8).map((item) => (
                <li key={item.knowledgePoint} className="rounded-xl border border-border bg-card px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{item.knowledgePoint}</span>
                        <span className="tabular-nums text-sm">{scoreLabel(item.score)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(item.score * 100)}%` }} />
                    </div>
                    {typeof item.evidenceCount === "number" && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t.persona.teacherHome.evidence.replace("{count}", String(item.evidenceCount))}
                        </p>
                    )}
                </li>
            ))}
        </ul>
    );
}

export function WeakPointList({
    items,
    empty,
}: {
    items: Array<{ knowledgePoint: string; itemCount: number; unmasteredCount?: number; score?: number }>;
    empty: string;
}) {
    const { t } = useLanguage();
    if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <div className="flex flex-wrap gap-2">
            {items.slice(0, 10).map((item) => (
                <Badge key={item.knowledgePoint} variant="secondary">
                    {item.knowledgePoint}
                    <span className="ml-1 text-muted-foreground">
                        {t.persona.teacherHome.itemCount.replace("{count}", String(item.itemCount))}
                    </span>
                </Badge>
            ))}
        </div>
    );
}

export function TodayStepList({
    steps,
    empty,
    studentKey,
}: {
    steps: Array<{ id?: string; title: string; reason?: string; type: string; status: string; knowledgePoints?: string[] }>;
    empty: string;
    studentKey?: string;
}) {
    const { t } = useLanguage();
    if (steps.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <ol className="space-y-2">
            {steps.map((step, index) => (
                <li key={step.id || `${step.title}-${index}`} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{step.title}</div>
                            {step.reason && <p className="mt-1 text-xs text-muted-foreground">{step.reason}</p>}
                            {step.knowledgePoints && step.knowledgePoints.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {step.knowledgePoints.map((point) => (
                                        <Badge key={point} variant="outline">{point}</Badge>
                                    ))}
                                </div>
                            )}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {t.learn.status[step.status as keyof typeof t.learn.status] || step.status}
                        </span>
                    </div>
                </li>
            ))}
            {studentKey && (
                <li>
                    <Link href={`/learn?studentKey=${encodeURIComponent(studentKey)}`} className="text-sm font-medium text-primary hover:underline">
                        {t.persona.teacherHome.openPath}
                    </Link>
                </li>
            )}
        </ol>
    );
}

function rateColor(rate: number): string {
    if (rate >= 50) return "bg-red-500";
    if (rate >= 25) return "bg-amber-500";
    return "bg-emerald-500";
}

export function ErrorRateList({
    items,
    empty,
}: {
    items: Array<{ knowledgePoint: string; errorRate: number; wrong: number; answered: number; studentCount: number }>;
    empty: string;
}) {
    const { t } = useLanguage();
    if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <div className="space-y-1.5">
            {items.map((item) => (
                <div key={item.knowledgePoint} className="flex items-center gap-2 text-sm">
                    <span className="w-28 shrink-0 truncate sm:w-36">{item.knowledgePoint}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                        <div className={cn("h-full", rateColor(item.errorRate))} style={{ width: `${Math.min(100, item.errorRate)}%` }} />
                    </div>
                    <span className="w-32 shrink-0 text-xs text-muted-foreground">
                        {t.persona.teacherHome.errorRate.replace("{rate}", `${item.errorRate}%`)}
                        {" · "}
                        {item.wrong}/{item.answered}
                    </span>
                </div>
            ))}
        </div>
    );
}

export function CauseList({
    items,
    empty,
}: {
    items: Array<{ cause: string; count: number; studentCount?: number }>;
    empty: string;
}) {
    const { t } = useLanguage();
    if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <div className="flex flex-wrap gap-2">
            {items.map((item) => (
                <Badge key={item.cause} variant="outline">
                    {item.cause === "未标注" ? t.persona.teacherHome.unlabeledCause : item.cause}
                    <span className="ml-1 text-muted-foreground">
                        {t.persona.teacherHome.causeCount.replace("{count}", String(item.count))}
                        {typeof item.studentCount === "number" && item.studentCount > 0
                            ? ` · ${t.persona.teacherHome.studentCount.replace("{count}", String(item.studentCount))}`
                            : ""}
                    </span>
                </Badge>
            ))}
        </div>
    );
}

export function PracticeTrendChart({
    days,
    empty,
}: {
    days: Array<{ date: string; attempted: number; correct: number }>;
    empty: string;
}) {
    const max = Math.max(1, ...days.map((day) => day.attempted));
    const hasData = days.some((day) => day.attempted > 0);
    if (!hasData) return <p className="text-sm text-muted-foreground">{empty}</p>;
    return (
        <div className="space-y-2">
            <div className="flex h-24 items-end gap-1">
                {days.map((day) => {
                    const height = (day.attempted / max) * 100;
                    const correctHeight = day.attempted === 0 ? 0 : (day.correct / day.attempted) * height;
                    return (
                        <div
                            key={day.date}
                            className="flex h-full min-w-0 flex-1 flex-col justify-end"
                            title={`${day.date}: ${day.correct}/${day.attempted}`}
                        >
                            <div className="relative w-full rounded-t bg-muted" style={{ height: `${height}%`, minHeight: day.attempted ? "4px" : undefined }}>
                                <div className="absolute bottom-0 left-0 right-0 rounded-t bg-primary" style={{ height: `${correctHeight}%` }} />
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>{days[0]?.date}</span>
                <span>{days[days.length - 1]?.date}</span>
            </div>
        </div>
    );
}

export function HomeSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="space-y-3">
            <h2 className="text-sm font-semibold">{title}</h2>
            {children}
        </section>
    );
}
