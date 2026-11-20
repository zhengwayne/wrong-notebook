"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { withChildParam } from "@/lib/current-child";
import { frontendLogger } from "@/lib/frontend-logger";
import { importQuestionImage, PartialQuestionImportError, resumeQuestionImport } from "@/lib/question-import";
import type { ImportedQuestion, PendingQuestionImport } from "@/lib/question-import";

interface BatchImportPanelProps {
    blobs: Blob[];
    /** 指定错题本；为空时按 AI 识别的学科匹配或新建错题本 */
    subjectId?: string | null;
    /** 家长/教师身份下归属的学习者 */
    learnerId?: string | null;
    timeout?: number;
    onClose: () => void;
}

type ItemStatus = "pending" | "analyzing" | "saving" | "success" | "failed";

interface BatchItem {
    status: ItemStatus;
    imported?: ImportedQuestion;
    error?: string;
    /** 识别成功但保存阶段部分失败：重试时只补存未成功的题，避免重复题 */
    pending?: PendingQuestionImport;
}

// 同时识别的题目数，避免一次性压垮 AI 服务
const CONCURRENCY = 3;

/** 一图多题：逐框识别并直接导入错题本 */
export function BatchImportPanel({ blobs, subjectId, learnerId, timeout, onClose }: BatchImportPanelProps) {
    const { t, language } = useLanguage();
    const [items, setItems] = useState<BatchItem[]>(() => blobs.map(() => ({ status: "pending" })));
    const startedRef = useRef(false);

    const updateItem = useCallback((index: number, patch: Partial<BatchItem>) => {
        setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
    }, []);

    const pendingRef = useRef(new Map<number, PendingQuestionImport>());

    const runOne = useCallback(async (index: number) => {
        const pending = pendingRef.current.get(index);
        updateItem(index, { status: pending ? "saving" : "analyzing", error: undefined });
        try {
            const imported = pending
                ? await resumeQuestionImport(pending)
                : await importQuestionImage(blobs[index], {
                    language,
                    subjectId,
                    learnerId,
                    timeout,
                    onStage: (stage) => updateItem(index, { status: stage }),
                });
            pendingRef.current.delete(index);
            updateItem(index, { status: "success", imported, pending: undefined });
        } catch (error) {
            const data = (error as { data?: { message?: string } })?.data;
            const backendError = data?.message || (error instanceof Error ? error.message : String(error));
            const mapped = (t.errors as Record<string, unknown>)[backendError];
            let message = typeof mapped === "string" ? mapped : backendError;
            let nextPending: PendingQuestionImport | undefined;
            if (error instanceof PartialQuestionImportError) {
                nextPending = error.pending;
                pendingRef.current.set(index, error.pending);
                if (error.totalCount > 1 && error.savedCount > 0) {
                    message = `${t.batchImport.partialSaved
                        .replace("{saved}", String(error.savedCount))
                        .replace("{total}", String(error.totalCount))} ${message}`;
                }
            }
            updateItem(index, { status: "failed", error: message, pending: nextPending });
            frontendLogger.error('[BatchImport]', 'Question import failed', { index, error: backendError });
        }
    }, [blobs, language, subjectId, learnerId, timeout, t.errors, t.batchImport.partialSaved, updateItem]);

    const runAll = useCallback(async (indexes: number[]) => {
        const queue = [...indexes];
        const worker = async () => {
            while (queue.length > 0) {
                await runOne(queue.shift()!);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    }, [runOne]);

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;
        runAll(blobs.map((_, index) => index));
    }, [blobs, runAll]);

    const done = items.filter((item) => item.status === "success").length;
    const failedIndexes = items.flatMap((item, index) => (item.status === "failed" ? [index] : []));
    const running = items.some((item) => item.status === "pending" || item.status === "analyzing" || item.status === "saving");

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">{t.batchImport.title}</CardTitle>
                <span className="text-sm text-muted-foreground">
                    {t.batchImport.summary
                        .replace("{done}", String(done))
                        .replace("{total}", String(items.length))
                        .replace("{failed}", String(failedIndexes.length))}
                </span>
            </CardHeader>
            <CardContent className="space-y-4">
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((item, index) => (
                        <li key={index} className="flex gap-3 rounded-lg border p-3">
                            <BlobThumbnail blob={blobs[index]} />
                            <div className="min-w-0 flex-1 space-y-1 text-sm">
                                <div className="font-medium">{t.batchImport.question.replace("{index}", String(index + 1))}</div>
                                <StatusLine item={item} />
                                {item.status === "success" && item.imported && (
                                    <div className="space-y-0.5">
                                        {(item.imported.savedItems ?? [item.imported]).map((saved) => (
                                            <Link key={saved.id} href={withChildParam(`/error-items/${saved.id}`, learnerId)} className="block truncate text-xs text-primary hover:underline">
                                                {saved.notebookName} · {saved.shortId}
                                            </Link>
                                        ))}
                                    </div>
                                )}
                                {item.status === "failed" && item.pending && item.pending.saved.some(Boolean) && (
                                    <div className="space-y-0.5">
                                        {item.pending.saved.flatMap((saved) => (saved ? [saved] : [])).map((saved) => (
                                            <Link key={saved.id} href={withChildParam(`/error-items/${saved.id}`, learnerId)} className="block truncate text-xs text-primary hover:underline">
                                                {saved.notebookName} · {saved.shortId}
                                            </Link>
                                        ))}
                                    </div>
                                )}
                                {item.status === "failed" && (
                                    <>
                                        {item.error && <p className="line-clamp-2 text-xs text-destructive">{item.error}</p>}
                                        <Button size="sm" variant="outline" className="h-7" onClick={() => runOne(index)}>
                                            <RotateCcw className="mr-1 h-3 w-3" />
                                            {t.batchImport.retry}
                                        </Button>
                                    </>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    {failedIndexes.length > 1 && !running && (
                        <Button variant="outline" onClick={() => runAll(failedIndexes)}>
                            <RotateCcw className="mr-2 h-4 w-4" />
                            {t.batchImport.retryFailed}
                        </Button>
                    )}
                    <Button onClick={onClose} disabled={running}>
                        {t.batchImport.finish}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

function StatusLine({ item }: { item: BatchItem }) {
    const { t } = useLanguage();
    const label = t.batchImport.status[item.status];
    if (item.status === "success") {
        return <span className="flex items-start gap-1 text-green-700 dark:text-green-300"><CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />{item.imported?.duplicate ? t.importFlow.duplicate : label}</span>;
    }
    if (item.status === "failed") {
        return <span className="flex items-center gap-1 text-destructive"><XCircle className="h-4 w-4" />{label}</span>;
    }
    return (
        <span className="flex items-center gap-1 text-muted-foreground">
            {item.status !== "pending" && <Loader2 className="h-4 w-4 animate-spin" />}
            {label}
        </span>
    );
}

/** 题目图片缩略图：在组件内创建并回收 blob URL */
function BlobThumbnail({ blob }: { blob: Blob }) {
    const imageRef = useRef<HTMLImageElement>(null);

    useEffect(() => {
        const url = URL.createObjectURL(blob);
        if (imageRef.current) imageRef.current.src = url;
        return () => URL.revokeObjectURL(url);
    }, [blob]);

    return <img ref={imageRef} alt="" className="h-20 w-20 shrink-0 rounded object-contain bg-muted" />;
}
