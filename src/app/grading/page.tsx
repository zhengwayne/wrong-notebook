"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ClipboardCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageLoading } from "@/components/ui/page-loading";
import { ClassManager } from "@/components/grading/class-manager";
import { TaskCreateForm } from "@/components/grading/task-create-form";
import { OnboardingStrip } from "@/components/onboarding/onboarding-strip";
import { useLanguage } from "@/contexts/LanguageContext";
import { useTimeZone } from "@/contexts/TimeZoneContext";
import { apiClient } from "@/lib/api-client";
import { formatDateTime } from "@/lib/date-time";
import { fillCopy } from "@/lib/onboarding-client";
import { usePageTitle } from "@/lib/page-title";
import type { GradingClassInfo, GradingTaskSummary } from "@/types/grading";

function GradingPageView() {
    const { t } = useLanguage();
    const { timeZone } = useTimeZone();
    usePageTitle(t.grading.title);
    const [tasks, setTasks] = useState<GradingTaskSummary[] | null>(null);
    const [classes, setClasses] = useState<GradingClassInfo[] | null>(null);
    const [showForm, setShowForm] = useState(false);

    const wantsNew = useSearchParams().get("new") === "1";
    useEffect(() => {
        // 引导里的「新建任务」带 ?new=1 直接展开表单（同页点击也生效）
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 跟随地址参数
        if (wantsNew) setShowForm(true);
    }, [wantsNew]);

    const noClass = classes !== null && !classes.some((item) => item.students.length > 0);
    const readyClass = classes?.find((item) => item.students.length > 0) ?? null;
    const ob = t.onboarding.teacher;

    useEffect(() => {
        apiClient.get<GradingTaskSummary[]>("/api/grading/tasks").then(setTasks).catch(() => setTasks([]));
        apiClient.get<GradingClassInfo[]>("/api/grading/classes").then(setClasses).catch(() => setClasses([]));
    }, []);

    return (
        <main id="main-content" tabIndex={-1} className="mx-auto min-h-screen max-w-6xl px-4 py-6 md:px-8 md:py-8">
            <div className="space-y-6">
                <PageHeader
                    title={t.grading.title}
                    description={t.grading.subtitle}
                    actions={(
                        <div className="flex gap-2">
                            <Button asChild variant="outline"><Link href="/variants">{t.variants.title}</Link></Button>
                            {!showForm && (
                                <Button onClick={() => setShowForm(true)} aria-label={t.grading.create}>
                                    <Plus className="h-4 w-4" /><span className="sm:hidden">{t.grading.createShort}</span><span className="hidden sm:inline">{t.grading.create}</span>
                                </Button>
                            )}
                        </div>
                    )}
                />
                <OnboardingStrip persona="teacher" />
                {noClass && <p className="text-sm text-muted-foreground" data-testid="grading-need-class">{ob.needClass}</p>}
                {showForm && classes && <TaskCreateForm classes={classes} />}

                <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
                    <section className="space-y-3">
                        <h2 className="text-lg font-semibold">{t.grading.list}</h2>
                        {tasks === null ? <PageLoading /> : tasks.length === 0 ? (
                            readyClass ? (
                                <EmptyState
                                    icon={ClipboardCheck}
                                    title={ob.emptyTasks.title}
                                    description={fillCopy(ob.emptyTasks.desc, { className: readyClass.name, students: readyClass.students.length })}
                                    className="py-10"
                                    action={!showForm && <Button onClick={() => setShowForm(true)}><Plus className="h-4 w-4" aria-hidden="true" />{ob.steps.task.action}</Button>}
                                />
                            ) : (
                                <EmptyState icon={ClipboardCheck} title={t.grading.empty} className="py-10" />
                            )
                        ) : (
                            <div className="grid gap-3 md:grid-cols-2">
                                {tasks.map((task) => (
                                    <Link key={task.id} href={`/grading/${task.id}`}>
                                        <Card className="h-full rounded-2xl transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                                            <CardContent className="space-y-2 pt-4">
                                                <div className="flex items-center gap-2 font-medium">
                                                    <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" />{task.title}
                                                </div>
                                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                    <span>{task.className} · {task.subjectName}</span>
                                                    <span>{formatDateTime(task.createdAt, "yyyy-MM-dd HH:mm", timeZone)}</span>
                                                    <span>{t.grading.questionCount.replace("{count}", String(task.questionCount))}</span>
                                                    <span>{t.grading.submissionCount.replace("{count}", String(task.submissionCount))}/{task.studentCount}</span>
                                                    <span>{t.grading.confirmedCount.replace("{count}", String(task.confirmedCount))}</span>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </section>
                    {classes === null ? <PageLoading /> : <ClassManager classes={classes} onChange={setClasses} />}
                </div>
            </div>
        </main>
    );
}

export default function GradingPage() {
    return <Suspense fallback={<PageLoading />}><GradingPageView /></Suspense>;
}
