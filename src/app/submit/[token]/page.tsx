"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Camera, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { compressPaperImages } from "@/lib/use-paper-images";

interface PublicTaskMeta {
    title: string;
    subjectName: string;
    deadline: string | null;
    maxPages: number;
}

export default function PublicSubmitHomeworkPage() {
    const { token } = useParams<{ token: string }>();
    const { t, language } = useLanguage();
    const copy = t.publicBridge;
    const fileRef = useRef<HTMLInputElement>(null);

    const [meta, setMeta] = useState<PublicTaskMeta | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [studentNo, setStudentNo] = useState("");
    const [studentName, setStudentName] = useState("");
    const [images, setImages] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitted, setSubmitted] = useState(false);

    useEffect(() => {
        let cancelled = false;
        apiClient
            .get<PublicTaskMeta>(`/api/public/grading-submit/${encodeURIComponent(token)}`)
            .then((res) => {
                if (!cancelled) setMeta(res);
            })
            .catch((err) => {
                if (!cancelled) setLoadError(getApiErrorMessage(err));
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    const handlePickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (files.length === 0) return;
        const maxPages = meta?.maxPages ?? 8;
        const allowed = files.slice(0, Math.max(0, maxPages - images.length));
        if (allowed.length === 0) return;

        setBusy(true);
        setError(null);
        try {
            const compressed = await compressPaperImages(allowed);
            setImages((prev) => [...prev, ...compressed].slice(0, maxPages));
        } catch (err) {
            setError(getApiErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!studentName.trim() || images.length === 0) return;
        setBusy(true);
        setError(null);
        try {
            await apiClient.post(`/api/public/grading-submit/${encodeURIComponent(token)}`, {
                studentNo: studentNo.trim() || undefined,
                studentName: studentName.trim(),
                images,
                language: language === "en" ? "en" : "zh",
            });
            setSubmitted(true);
        } catch (err) {
            setError(getApiErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (loadError) {
        return (
            <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
                <div className="w-full rounded-2xl border border-destructive/30 bg-card p-6 text-center">
                    <p className="text-sm font-medium text-destructive">{loadError}</p>
                </div>
            </main>
        );
    }

    if (!meta) {
        return (
            <main className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </main>
        );
    }

    if (submitted) {
        return (
            <main className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
                <div className="w-full space-y-3 rounded-2xl border border-emerald-500/30 bg-card p-6 text-center shadow-sm">
                    <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600 dark:text-emerald-400" />
                    <h1 className="text-lg font-semibold">{copy.submitSuccessTitle}</h1>
                    <p className="text-sm text-muted-foreground">{copy.submitSuccessDesc}</p>
                </div>
            </main>
        );
    }

    return (
        <main className="mx-auto min-h-screen max-w-lg px-4 py-8">
            <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-border bg-card p-5 shadow-xs">
                <div>
                    <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                        {meta.subjectName}
                    </span>
                    <h1 className="mt-2 text-xl font-bold">{meta.title}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">{copy.submitPageTitle}</p>
                </div>

                <div className="space-y-3">
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-foreground">{copy.studentNoLabel}</label>
                        <Input
                            value={studentNo}
                            onChange={(e) => setStudentNo(e.target.value)}
                            placeholder={copy.studentNoPlaceholder}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-foreground">{copy.studentNameLabel}</label>
                        <Input
                            required
                            value={studentName}
                            onChange={(e) => setStudentName(e.target.value)}
                            placeholder={copy.studentNamePlaceholder}
                        />
                    </div>
                </div>

                <div className="space-y-3">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => void handlePickFiles(e)}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        disabled={busy || images.length >= meta.maxPages}
                        onClick={() => fileRef.current?.click()}
                    >
                        <Camera className="h-4 w-4" aria-hidden="true" />
                        {copy.addPhotos.replace("{max}", String(meta.maxPages))} ({images.length}/{meta.maxPages})
                    </Button>

                    {images.length > 0 && (
                        <div className="grid grid-cols-3 gap-2">
                            {images.map((img, idx) => (
                                <div key={idx} className="relative overflow-hidden rounded-xl border border-border">
                                    <img src={img} alt={`Page ${idx + 1}`} className="h-28 w-full object-cover" />
                                    <button
                                        type="button"
                                        aria-label={copy.removePhoto}
                                        onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                                        className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-destructive shadow-xs"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {error && <p className="text-xs text-destructive">{error}</p>}

                <Button
                    type="submit"
                    className="w-full"
                    disabled={busy || !studentName.trim() || images.length === 0}
                >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {busy ? copy.submitting : copy.submitNow}
                </Button>
            </form>
        </main>
    );
}
