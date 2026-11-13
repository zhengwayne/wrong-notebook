"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ClipboardCheck, Download, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/grading/native-select";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePageTitle } from "@/lib/page-title";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import type { GradingClassInfo } from "@/types/grading";

type Tab = "queue" | "weakness" | "compare";

interface RunItem {
    id: string;
    index: number;
    status: "verified" | "pending_review" | "rejected" | "approved";
    plan?: { vary?: string; skill?: string; difficulty?: string; knowledgePoints?: string[] } | null;
    questionText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
    verification?: { detail?: string; passed?: boolean; computable?: boolean; expected?: string; actual?: string; resolveAnswer?: string; resolveAgreed?: boolean } | null;
    similarTo?: string | null;
    plannedDifficulty?: string | null;
    checkedDifficulty?: string | null;
    reviewNote?: string | null;
}

interface Run {
    id: string;
    kind: string;
    mode: string;
    status: string;
    title?: string | null;
    studentName?: string;
    className?: string;
    examPaperId?: string | null;
    weaknessProfile?: { weaknesses?: Array<{ knowledgePoint: string; score: number; itemCount: number; unmasteredCount: number }>; suggestedDifficulty?: string } | null;
    topicSuggestion?: { title?: string; reason?: string; knowledgePoints?: string[]; outline?: string[] } | null;
    totalLatencyMs?: number | null;
    totalTokens?: number | null;
    items?: RunItem[];
    counts?: Record<string, number>;
    startedAt: string;
}

export const dynamic = "force-dynamic";

function VariantsContent() {
    const { t, language } = useLanguage();
    const v = t.variants;
    usePageTitle(v.title);
    const search = useSearchParams();
    const [tab, setTab] = useState<Tab>((search.get("tab") as Tab) || "queue");
    const [runs, setRuns] = useState<Run[] | null>(null);
    const [selected, setSelected] = useState<string | null>(search.get("run"));
    const [run, setRun] = useState<Run | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const loadRuns = () => apiClient.get<{ runs: Run[] }>("/api/variants/runs").then((data) => setRuns(data.runs)).catch(() => setRuns([]));

    useEffect(() => { void loadRuns(); }, []);
    useEffect(() => {
        if (!selected) return;
        let cancelled = false;
        apiClient.get<{ run: Run }>(`/api/variants/runs/${selected}`).then((data) => {
            if (!cancelled) setRun(data.run);
        }).catch(() => {
            if (!cancelled) setRun(null);
        });
        return () => { cancelled = true; };
    }, [selected]);

    const current = (run && run.id === selected ? run : null) || runs?.find((item) => item.id === selected) || null;

    return (
        <main id="main-content" tabIndex={-1} className="mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-5">
                <PageHeader title={v.title} description={v.subtitle} />
                <SegmentedControl<Tab> value={tab} onChange={setTab} options={[
                    { value: "queue", label: v.tabs.queue, icon: ClipboardCheck },
                    { value: "weakness", label: v.tabs.weakness, icon: Sparkles },
                    { value: "compare", label: v.tabs.compare, icon: Download },
                ]} />
                {tab === "queue" && (
                    <QueuePanel v={v} runs={runs} selected={selected} current={current} busy={busy}
                        onSelect={setSelected}
                        onReviewed={() => { void loadRuns(); if (selected) apiClient.get<{ run: Run }>(`/api/variants/runs/${selected}`).then((data) => setRun(data.run)); }}
                        setBusy={setBusy} />
                )}
                {tab === "weakness" && <WeaknessPanel v={v} language={language} onStarted={() => { setTab("queue"); void loadRuns(); }} />}
                {tab === "compare" && <ComparePanel v={v} />}
            </div>
        </main>
    );
}

function statusLabel(v: ReturnType<typeof useLanguage>["t"]["variants"], status: string) {
    return (v.status as Record<string, string>)[status] || status;
}

function QueuePanel({ v, runs, selected, current, busy, onSelect, onReviewed, setBusy }: {
    v: ReturnType<typeof useLanguage>["t"]["variants"];
    runs: Run[] | null;
    selected: string | null;
    current: Run | null;
    busy: string | null;
    onSelect: (id: string) => void;
    onReviewed: () => void;
    setBusy: (id: string | null) => void;
}) {
    if (runs === null) return <PageLoading />;
    if (runs.length === 0) return <p className="text-sm text-muted-foreground">{v.empty}</p>;
    return (
        <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
            <div className="space-y-2">
                {runs.map((item) => (
                    <button key={item.id} type="button" onClick={() => onSelect(item.id)}
                        className={`w-full rounded-xl border p-3 text-left text-sm ${selected === item.id ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}>
                        <div className="font-medium">{item.title || (v.kind as Record<string, string>)[item.kind] || item.kind}</div>
                        <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                            <span>{(v.mode as Record<string, string>)[item.mode]}</span>
                            {item.studentName && <span>{item.studentName}</span>}
                            {item.className && <span>{item.className}</span>}
                            {item.counts && <span>{v.status.pending_review} {item.counts.pending_review || 0}</span>}
                        </div>
                    </button>
                ))}
            </div>
            <div className="space-y-3">
                {!current ? <p className="text-sm text-muted-foreground">{v.empty}</p> : (
                    <>
                        {current.topicSuggestion && (
                            <Card>
                                <CardHeader><CardTitle className="text-lg">{current.topicSuggestion.title}</CardTitle></CardHeader>
                                <CardContent className="space-y-2 text-sm">
                                    <p>{v.reason}：{current.topicSuggestion.reason}</p>
                                    {current.topicSuggestion.outline && (
                                        <ol className="list-decimal space-y-1 pl-5">{current.topicSuggestion.outline.map((step) => <li key={step}>{step}</li>)}</ol>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                        {current.items?.some((item) => item.status === "approved") && !current.examPaperId && (
                            <Button onClick={async () => {
                                setBusy("exam");
                                try {
                                    const result = await apiClient.post<{ id: string; questionCount: number }>(`/api/variants/runs/${current.id}/exam`, {});
                                    toast.success(v.examCreated.replace("{count}", String(result.questionCount)));
                                    onReviewed();
                                } catch { toast.error(v.noApproved); } finally { setBusy(null); }
                            }} disabled={busy === "exam"}>{v.toExam}</Button>
                        )}
                        {current.examPaperId && <Button asChild variant="outline"><Link href={`/exams/${current.examPaperId}`}>{v.toExam}</Link></Button>}
                        {current.items?.map((item) => <ItemCard key={item.id} item={item} v={v} busy={busy} setBusy={setBusy} onReviewed={onReviewed} />)}
                    </>
                )}
            </div>
        </div>
    );
}

function ItemCard({ item, v, busy, setBusy, onReviewed }: { item: RunItem; v: ReturnType<typeof useLanguage>["t"]["variants"]; busy: string | null; setBusy: (id: string | null) => void; onReviewed: () => void }) {
    const [questionText, setQuestionText] = useState(item.questionText || "");
    const [answerText, setAnswerText] = useState(item.answerText || "");
    const [analysis, setAnalysis] = useState(item.analysis || "");
    const review = async (action: "approve" | "reject") => {
        setBusy(item.id);
        try {
            await apiClient.patch(`/api/variants/items/${item.id}`, { action: action === "approve" ? (questionText !== item.questionText || answerText !== item.answerText || analysis !== item.analysis ? "edit" : "approve") : "reject", questionText, answerText, analysis });
            onReviewed();
        } catch (error) { toast.error(error); } finally { setBusy(null); }
    };
    return (
        <Card className={item.status === "pending_review" ? "border-amber-500/50" : ""}>
            <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{statusLabel(v, item.status)}</Badge>
                    {item.plannedDifficulty && <span className="text-xs text-muted-foreground">{item.plannedDifficulty}{item.checkedDifficulty ? ` → ${item.checkedDifficulty}` : ""}</span>}
                </div>
                {item.plan && <p className="text-xs text-muted-foreground">{v.plan}：{item.plan.vary} · {item.plan.skill}</p>}
            </CardHeader>
            <CardContent className="space-y-2">
                <Textarea rows={4} value={questionText} onChange={(event) => setQuestionText(event.target.value)} disabled={item.status === "approved"} />
                <Input value={answerText} onChange={(event) => setAnswerText(event.target.value)} disabled={item.status === "approved"} />
                <Textarea rows={3} value={analysis} onChange={(event) => setAnalysis(event.target.value)} disabled={item.status === "approved"} />
                {item.verification && (
                    <p className="text-xs text-muted-foreground">{v.evidence}：{item.verification.detail}{item.verification.resolveAgreed === false ? ` · ${item.verification.resolveAnswer || ""}` : ""}{item.similarTo ? ` · ${v.similar}` : ""}</p>
                )}
                {item.status !== "approved" && item.status !== "rejected" && (
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy === item.id} onClick={() => review("approve")}>{v.saveApprove}</Button>
                        <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => review("reject")}>{v.reject}</Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function WeaknessPanel({ v, language, onStarted }: { v: ReturnType<typeof useLanguage>["t"]["variants"]; language: "zh" | "en"; onStarted: () => void }) {
    const [classes, setClasses] = useState<GradingClassInfo[]>([]);
    const [classId, setClassId] = useState("");
    const [studentId, setStudentId] = useState("");
    const [count, setCount] = useState(5);
    const [data, setData] = useState<{ classWeaknesses?: Array<{ knowledgePoint: string; studentCount: number; averageScore: number }>; students?: Array<{ studentId: string; name: string; profile: { weaknesses: Array<{ knowledgePoint: string; score: number; itemCount: number; unmasteredCount: number }>; suggestedDifficulty: string; itemCount: number } }>; profile?: { weaknesses: Array<{ knowledgePoint: string; score: number; itemCount: number; unmasteredCount: number }>; suggestedDifficulty: string; itemCount: number }; topicBrief?: { knowledgePoints: string[]; reason: string } } | null>(null);
    const [busy, setBusy] = useState(false);
    const students = useMemo(() => classes.find((item) => item.id === classId)?.students || [], [classes, classId]);

    useEffect(() => { apiClient.get<GradingClassInfo[]>("/api/grading/classes").then(setClasses).catch(() => setClasses([])); }, []);
    useEffect(() => {
        if (!classId && !studentId) return;
        const query = studentId ? `studentId=${studentId}` : `classId=${classId}`;
        apiClient.get<NonNullable<typeof data>>(`/api/variants/weakness?${query}`).then(setData).catch(() => setData(null));
    }, [classId, studentId]);

    const start = async (kind: "personalized_set" | "topic" | "class_topic") => {
        setBusy(true);
        try {
            await apiClient.post("/api/variants/runs", { kind: kind === "topic" && classId && !studentId ? "class_topic" : kind, classId: classId || undefined, studentId: studentId || undefined, count, language }, { timeout: 180000, recoverable: true });
            toast.success(v.start);
            onStarted();
        } catch (error) { toast.error(error); } finally { setBusy(false); }
    };

    const profile = studentId ? data?.profile : undefined;
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <NativeSelect aria-label={v.selectClass} value={classId} onChange={(event) => { setClassId(event.target.value); setStudentId(""); }}>
                    <option value="">{v.selectClass}</option>
                    {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </NativeSelect>
                <NativeSelect aria-label={v.selectStudent} value={studentId} onChange={(event) => setStudentId(event.target.value)} disabled={!classId}>
                    <option value="">{v.selectStudent}</option>
                    {students.map((item) => <option key={item.id} value={item.id}>{item.studentNo ? `${item.studentNo} · ` : ""}{item.name}</option>)}
                </NativeSelect>
                <Input type="number" min={3} max={8} value={count} onChange={(event) => setCount(Math.min(8, Math.max(3, Number(event.target.value) || 5)))} aria-label={v.count} />
            </div>
            <div className="flex flex-wrap gap-2">
                {studentId && <Button disabled={busy} onClick={() => start("personalized_set")}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{v.generateSet}</Button>}
                {studentId && <Button variant="secondary" disabled={busy} onClick={() => start("topic")}>{v.generateTopic}</Button>}
                {classId && !studentId && <Button disabled={busy} onClick={() => start("class_topic")}>{v.generateClassTopic}</Button>}
                {classId && !studentId && <Button variant="secondary" disabled={busy} onClick={() => start("personalized_set")}>{v.generateClassSets}</Button>}
            </div>
            {data?.classWeaknesses && (
                <section className="space-y-2">
                    <h3 className="font-medium">{v.commonWeaknesses}</h3>
                    {data.classWeaknesses.length === 0 ? <p className="text-sm text-muted-foreground">{v.noCommon}</p> : (
                        <ul className="space-y-1 text-sm">{data.classWeaknesses.map((item) => <li key={item.knowledgePoint}>{item.knowledgePoint} · {item.studentCount} · {v.score.replace("{value}", String(item.averageScore))}</li>)}</ul>
                    )}
                    {data.topicBrief?.reason && <p className="text-sm text-muted-foreground">{data.topicBrief.reason}</p>}
                </section>
            )}
            {profile && (
                <section className="space-y-2">
                    <h3 className="font-medium">{v.profileTitle}</h3>
                    <p className="text-xs text-muted-foreground">{v.suggestedDifficulty.replace("{value}", profile.suggestedDifficulty)} · {v.items.replace("{count}", String(profile.itemCount))}</p>
                    <ul className="space-y-1 text-sm">
                        {profile.weaknesses.slice(0, 8).map((item) => (
                            <li key={item.knowledgePoint}>{item.knowledgePoint} · {v.score.replace("{value}", String(item.score))} · {v.unmastered.replace("{count}", String(item.unmasteredCount))}</li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

function ComparePanel({ v }: { v: ReturnType<typeof useLanguage>["t"]["variants"] }) {
    const [data, setData] = useState<{ totals: Record<string, { count: number; verifyRate: number | null; difficultyMatchRate: number | null; latencyMs: number | null; totalTokens: number | null; cost: number | null }>; runs: Array<Record<string, string | number | null>> } | null>(null);
    useEffect(() => { apiClient.get<NonNullable<typeof data>>("/api/variants/compare").then(setData).catch(() => setData(null)); }, []);
    if (!data) return <PageLoading />;
    const card = (mode: "pipeline" | "legacy") => {
        const row = data.totals[mode];
        return (
            <Card>
                <CardHeader><CardTitle>{v.mode[mode]}</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-sm">
                    <p>{v.runs.replace("{count}", String(row.count))}</p>
                    <p>{v.verifyRate}：{row.verifyRate ?? "—"}%</p>
                    <p>{v.difficultyRate}：{row.difficultyMatchRate ?? "—"}%</p>
                    <p>{v.latency}：{row.latencyMs != null ? v.latencyMs.replace("{value}", String(row.latencyMs)) : "—"}</p>
                    <p>{v.tokens}：{row.totalTokens ?? "—"}</p>
                    <p>{v.cost}：{row.cost ?? "—"}</p>
                </CardContent>
            </Card>
        );
    };
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{v.compareHint}</p>
            <Button asChild variant="outline"><a href="/api/variants/compare?format=csv">{v.exportCsv}</a></Button>
            <div className="grid gap-3 md:grid-cols-2">{card("pipeline")}{card("legacy")}</div>
        </div>
    );
}

export default function VariantsPage() {
    return <Suspense fallback={<PageLoading />}><VariantsContent /></Suspense>;
}
