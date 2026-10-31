"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, Camera, KeyRound, ListChecks, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ClassSummary } from "@/components/grading/class-summary";
import { KeyEditor } from "@/components/grading/key-editor";
import { PaperCapture } from "@/components/grading/paper-capture";
import { SubmissionList } from "@/components/grading/submission-list";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog } from "@/lib/feedback";
import { usePageTitle } from "@/lib/page-title";
import type { GradingTaskDetail } from "@/types/grading";

type Tab = "key" | "capture" | "papers" | "summary";
const TABS: Tab[] = ["key", "capture", "papers", "summary"];

function GradingTaskView() {
    const { id } = useParams<{ id: string }>();
    const searchParams = useSearchParams();
    const router = useRouter();
    const { t } = useLanguage();
    const [task, setTask] = useState<GradingTaskDetail | null>(null);
    const initialTab = searchParams.get("tab");
    const [tab, setTab] = useState<Tab>(TABS.includes(initialTab as Tab) ? initialTab as Tab : "capture");
    usePageTitle(task?.title || t.grading.title);

    const load = useCallback(() => {
        apiClient.get<GradingTaskDetail>(`/api/grading/tasks/${id}`).then(setTask).catch(() => router.replace("/grading"));
    }, [id, router]);

     
    useEffect(() => { load(); }, [load]);

    // 有答卷在判分时每 4 秒刷新一次状态
    const busy = task?.submissions.some((submission) => submission.status === "pending" || submission.status === "grading");
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
    }, [busy, load]);

    if (!task) return <PageLoading />;

    const removeTask = async () => {
        if (!(await confirmDialog(t.grading.confirmDeleteTask, { destructive: true }))) return;
        await apiClient.delete(`/api/grading/tasks/${id}`);
        router.replace("/grading");
    };

    const submittedIds = new Set(task.submissions.map((submission) => submission.studentId).filter((value): value is string => !!value));
    const version = task.submissions.map((submission) => `${submission.id}:${submission.status}:${submission.totalScore}`).join("|");

    return (
        <main className="mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-5">
                <PageHeader
                    backHref="/grading"
                    title={task.title}
                    description={`${task.className} · ${task.subjectName} · ${t.grading.questionCount.replace("{count}", String(task.questions.length))} · ${t.grading.submissionCount.replace("{count}", String(task.submissions.length))}/${task.students.length}`}
                    actions={<Button variant="ghost" size="icon" aria-label={t.grading.deleteTask} onClick={removeTask}><Trash2 className="h-4 w-4" /></Button>}
                    className="print:hidden"
                />
                <SegmentedControl<Tab> className="print:hidden" value={tab} onChange={setTab} options={[
                    { value: "key", label: t.grading.tabs.key, icon: KeyRound },
                    { value: "capture", label: t.grading.tabs.capture, icon: Camera },
                    { value: "papers", label: t.grading.tabs.papers, icon: ListChecks },
                    { value: "summary", label: t.grading.tabs.summary, icon: BarChart3 },
                ]} />
                {tab === "key" && <KeyEditor key={task.questions.map((q) => q.id).join()} taskId={task.id} initial={task.questions} onSaved={load} />}
                {tab === "capture" && (task.questions.length === 0
                    ? <p className="text-sm text-muted-foreground">{t.grading.noKey}</p>
                    : <PaperCapture taskId={task.id} students={task.students} submittedIds={submittedIds} onUploaded={() => { load(); setTab("papers"); }} />)}
                {tab === "papers" && <SubmissionList taskId={task.id} students={task.students} submissions={task.submissions} />}
                {tab === "summary" && <ClassSummary taskId={task.id} version={version} />}
            </div>
        </main>
    );
}

export default function GradingTaskPage() {
    return <Suspense fallback={<PageLoading />}><GradingTaskView /></Suspense>;
}
