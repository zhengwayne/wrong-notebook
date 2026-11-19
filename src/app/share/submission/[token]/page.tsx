"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { BookPlus, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import type { ProcessLevel } from "@/lib/ai/exam-paper-read";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { scoreRatioToGradeLevel } from "@/lib/grading-grades";

interface SharedSubmissionCard {
    taskTitle: string;
    subjectName: string;
    scoringMode: string;
    studentName: string;
    totalScore: number | null;
    maxTotalScore: number;
    handwritingLevel: ProcessLevel | null;
    neatnessLevel: ProcessLevel | null;
    attitudeLevel: ProcessLevel | null;
    teacherComment: string | null;
    wrongQuestions: Array<{
        id: string;
        number: string;
        questionText: string;
        studentAnswer: string;
        correctAnswer: string;
        score: number;
        maxScore: number;
        reason: string;
        comment: string;
        knowledgePoints: string[];
    }>;
}

interface LearnerOption {
    id: string;
    name: string;
    kind: string;
}

export default function SharedSubmissionFeedbackPage() {
    const { token } = useParams<{ token: string }>();
    const { status } = useSession();
    const { t } = useLanguage();
    const copy = t.publicBridge;
    const levelLabels = t.grading.processEval.levels;

    const [card, setCard] = useState<SharedSubmissionCard | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [children, setChildren] = useState<LearnerOption[]>([]);
    const [selectedChildId, setSelectedChildId] = useState("");
    const [importing, setImporting] = useState(false);
    const [importMsg, setImportMsg] = useState<string | null>(null);
    const [importErr, setImportErr] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        apiClient
            .get<SharedSubmissionCard>(`/api/public/grading-share/${encodeURIComponent(token)}`)
            .then((res) => {
                if (!cancelled) setCard(res);
            })
            .catch((err) => {
                if (!cancelled) setLoadError(getApiErrorMessage(err));
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    useEffect(() => {
        if (status !== "authenticated") return;
        let cancelled = false;
        apiClient
            .get<{ learners: LearnerOption[] }>("/api/learners")
            .then((res) => {
                if (cancelled) return;
                const kids = (res.learners ?? []).filter((l) => l.kind === "child");
                setChildren(kids);
                if (kids[0]) setSelectedChildId(kids[0].id);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [status]);

    const handleImport = async () => {
        if (!selectedChildId) return;
        setImporting(true);
        setImportErr(null);
        try {
            const res = await apiClient.post<{ importedCount: number; skippedCount: number }>(
                "/api/parent/import-shared-submission",
                { token, learnerId: selectedChildId },
            );
            setImportMsg(
                copy.importedDone
                    .replace("{imported}", String(res.importedCount))
                    .replace("{skipped}", String(res.skippedCount)),
            );
        } catch (err) {
            setImportErr(getApiErrorMessage(err));
        } finally {
            setImporting(false);
        }
    };

    if (loadError) {
        return (
            <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
                <div className="w-full rounded-2xl border border-destructive/30 bg-card p-6 text-center text-sm text-destructive">
                    {loadError}
                </div>
            </main>
        );
    }
    if (!card) {
        return (
            <main className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </main>
        );
    }

    const scoreDisplay = card.totalScore !== null
        ? (card.scoringMode === "grade"
            ? t.grading.quickGrading.gradeLabels[scoreRatioToGradeLevel(card.totalScore, card.maxTotalScore)]
            : `${card.totalScore} / ${card.maxTotalScore}`)
        : "—";

    return (
        <main className="mx-auto min-h-screen max-w-2xl space-y-5 px-4 py-8">
            <section className="rounded-2xl border border-border bg-card p-5 shadow-xs space-y-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                            {card.subjectName}
                        </span>
                        <h1 className="mt-2 text-xl font-bold">{card.taskTitle}</h1>
                        <p className="text-sm text-muted-foreground">{card.studentName} · {copy.sharePageTitle}</p>
                    </div>
                    <div className="text-right">
                        <div className="text-xs text-muted-foreground">{copy.scoreLabel}</div>
                        <div className="text-2xl font-bold text-primary">{scoreDisplay}</div>
                    </div>
                </div>

                {(card.handwritingLevel || card.neatnessLevel || card.attitudeLevel) && (
                    <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/50 p-3 text-center text-xs">
                        <div>
                            <div className="text-muted-foreground">{copy.handwriting}</div>
                            <div className="mt-1 font-semibold">{card.handwritingLevel ? levelLabels[card.handwritingLevel] : "—"}</div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">{copy.neatness}</div>
                            <div className="mt-1 font-semibold">{card.neatnessLevel ? levelLabels[card.neatnessLevel] : "—"}</div>
                        </div>
                        <div>
                            <div className="text-muted-foreground">{copy.attitude}</div>
                            <div className="mt-1 font-semibold">{card.attitudeLevel ? levelLabels[card.attitudeLevel] : "—"}</div>
                        </div>
                    </div>
                )}

                {card.teacherComment && (
                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
                        <div className="text-xs font-semibold text-primary">{copy.teacherCommentTitle}</div>
                        <p className="mt-1">{card.teacherComment}</p>
                    </div>
                )}
            </section>

            {card.wrongQuestions.length > 0 && (
                <section className="rounded-2xl border border-primary/30 bg-card p-5 space-y-3">
                    <h2 className="text-sm font-semibold">{copy.importCardTitle}</h2>
                    <p className="text-xs text-muted-foreground">{copy.importCardDesc}</p>
                    {status === "authenticated" ? (
                        children.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <select
                                    value={selectedChildId}
                                    onChange={(e) => setSelectedChildId(e.target.value)}
                                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                                >
                                    {children.map((c) => (
                                        <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                </select>
                                <Button size="sm" disabled={importing} onClick={() => void handleImport()}>
                                    <BookPlus className="h-4 w-4" aria-hidden="true" />
                                    {importing ? copy.importing : copy.importButton}
                                </Button>
                                <Button size="sm" variant="outline" asChild>
                                    <Link href={`/parent?learnerId=${encodeURIComponent(selectedChildId)}`}>{copy.goParentHome}</Link>
                                </Button>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span>{copy.noChildHint}</span>
                                <Button size="sm" variant="outline" asChild><Link href="/parent">{copy.goParentHome}</Link></Button>
                            </div>
                        )
                    ) : (
                        <Button size="sm" asChild>
                            <Link href={`/login?callbackUrl=${encodeURIComponent(`/share/submission/${token}`)}`}>
                                {copy.loginToImport}
                            </Link>
                        </Button>
                    )}
                    {importMsg && (
                        <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-4 w-4" />{importMsg}
                        </p>
                    )}
                    {importErr && <p className="text-xs text-destructive">{importErr}</p>}
                </section>
            )}

            <section className="space-y-3">
                <h2 className="text-sm font-semibold">
                    {copy.wrongListTitle.replace("{count}", String(card.wrongQuestions.length))}
                </h2>
                {card.wrongQuestions.length === 0 ? (
                    <p className="rounded-2xl border border-border bg-card p-5 text-sm text-emerald-600 dark:text-emerald-400">
                        {copy.allCorrect}
                    </p>
                ) : (
                    card.wrongQuestions.map((q) => (
                        <div key={q.id} className="rounded-2xl border border-border bg-card p-4 space-y-2 text-sm">
                            <div className="flex items-center justify-between font-semibold">
                                <span>#{q.number}</span>
                                <span className="text-xs text-muted-foreground">{q.score} / {q.maxScore}</span>
                            </div>
                            <p className="whitespace-pre-wrap">{q.questionText}</p>
                            <div className="text-xs text-destructive">{copy.studentAnswerLabel}{q.studentAnswer || "—"}</div>
                            <div className="text-xs text-emerald-700 dark:text-emerald-400">{copy.correctAnswerLabel}{q.correctAnswer}</div>
                            {q.reason && <p className="text-xs text-muted-foreground">{q.reason}</p>}
                        </div>
                    ))
                )}
            </section>
        </main>
    );
}
