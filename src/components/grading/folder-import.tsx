"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Check, FolderOpen, Files, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { ApiError, apiClient } from "@/lib/api-client";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import {
    computeImportKey,
    FOLDER_IMPORT_CONCURRENCY,
    FOLDER_IMPORT_MAX_FILE_BYTES,
    FOLDER_IMPORT_MAX_PAGES,
    FOLDER_IMPORT_MAX_PAPERS,
    FOLDER_IMPORT_MAX_TOTAL_BYTES,
    groupImportFiles,
    matchImportPapers,
    runWithConcurrency,
    sourcesFromDataTransfer,
    sourcesFromFileList,
    type IgnoredFile,
    type ImportPaper,
    type ImportSourceFile,
} from "@/lib/folder-import";
import { studentLabel } from "@/lib/grading-labels";
import { HEIC_UNSUPPORTED } from "@/lib/heic";
import type { PaperIdentity } from "@/lib/student-match";
import { compressPaperImages } from "@/lib/use-paper-images";
import type { GradingStudentInfo } from "@/types/grading";

const SKIP = "__skip";

type ItemStatus = "ready" | "compressing" | "uploading" | "done" | "reused" | "failed" | "skipped";

interface ImportItem extends ImportPaper {
    autoStudentId: string | null;
    identity: PaperIdentity | null;
    alreadySubmitted: boolean;
    /** "" = AI 读卷头；SKIP = 跳过；其余为学生 id */
    choice: string;
    status: ItemStatus;
    error?: string;
}

interface FolderImportProps {
    taskId: string;
    students: GradingStudentInfo[];
    submittedIds: Set<string>;
    multiClass: boolean;
    onUploaded: () => void;
}

/**
 * 文件夹导入：一次选中/拖入整批扫描好的卷子，预览分组与学生匹配后排队上传，判分沿用收卷的后台流程。
 */
export function FolderImport({ taskId, students, submittedIds, multiClass, onUploaded }: FolderImportProps) {
    const { t, language } = useLanguage();
    const fi = t.grading.folderImport;
    const [items, setItems] = useState<ImportItem[]>([]);
    const [ignored, setIgnored] = useState<IgnoredFile[]>([]);
    const [overflow, setOverflow] = useState(0);
    const [tooLarge, setTooLarge] = useState(false);
    const [reading, setReading] = useState(false);
    const [running, setRunning] = useState(false);
    const [dragging, setDragging] = useState(false);
    const filesRef = useRef<HTMLInputElement>(null);
    const folderRef = useRef<HTMLInputElement>(null);
    const itemsRef = useRef<ImportItem[]>([]);
    const keyCache = useRef(new Map<string, string>());

    // React 不认识 webkitdirectory 属性，挂载时手动设置
    const setFolderInput = useCallback((node: HTMLInputElement | null) => {
        folderRef.current = node;
        if (node) {
            node.setAttribute("webkitdirectory", "");
            node.setAttribute("directory", "");
        }
    }, []);

    const commit = (next: ImportItem[]) => {
        itemsRef.current = next;
        setItems(next);
    };
    const patch = (key: string, change: Partial<ImportItem>) => {
        commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...change } : item)));
    };

    const load = (sources: ImportSourceFile[]) => {
        const grouped = groupImportFiles(sources);
        const roster = students.map((student) => ({ id: student.id, name: student.name, studentNo: student.studentNo, classId: student.classId || "", className: student.className || "" }));
        const matches = matchImportPapers(grouped.papers.map((paper) => paper.label), roster, submittedIds);
        commit(grouped.papers.map((paper, index) => ({
            ...paper,
            autoStudentId: matches[index].studentId,
            identity: matches[index].identity,
            alreadySubmitted: matches[index].alreadySubmitted,
            choice: paper.tooManyPages ? SKIP : matches[index].studentId || "",
            status: paper.tooManyPages ? "skipped" : "ready",
        })));
        keyCache.current.clear();
        setIgnored(grouped.ignored);
        setOverflow(grouped.overflow.length);
        setTooLarge(grouped.tooLarge);
        if (grouped.papers.length === 0) toast.error(fi.empty);
    };

    const onPick = (input: HTMLInputElement | null) => {
        if (!input?.files?.length) return;
        load(sourcesFromFileList(input.files));
        input.value = "";
    };

    const onDrop = async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        if (running) return;
        setReading(true);
        try {
            load(await sourcesFromDataTransfer(event.dataTransfer));
        } catch (error) {
            toast.error(getErrorMessage(error));
        } finally {
            setReading(false);
        }
    };

    const uploadOne = async (item: ImportItem, stop: { quota: boolean }) => {
        if (stop.quota) return;
        patch(item.key, { status: "compressing", error: undefined });
        try {
            const images = await compressPaperImages(item.pages.map((page) => page.file));
            let importKey = keyCache.current.get(item.key);
            if (!importKey) {
                importKey = await computeImportKey(taskId, item);
                keyCache.current.set(item.key, importKey);
            }
            if (stop.quota) {
                patch(item.key, { status: "failed", error: fi.quotaStopped });
                return;
            }
            patch(item.key, { status: "uploading" });
            const current = itemsRef.current.find((entry) => entry.key === item.key) ?? item;
            const manual = current.choice && current.choice !== current.autoStudentId ? current.choice : null;
            const result = await apiClient.post<{ id: string; reused: boolean }>(`/api/grading/tasks/${taskId}/folder-import`, {
                importKey,
                images,
                studentId: manual,
                // 采用按名字匹配的结果时发身份让服务端重新匹配；选了「AI 读卷头」就什么都不发
                identity: !manual && current.choice ? current.identity : null,
                language,
            }, { timeout: 180000 });
            patch(item.key, { status: result.reused ? "reused" : "done" });
        } catch (error) {
            if (error instanceof ApiError && error.status === 429) stop.quota = true;
            const isHeic = getErrorMessage(error) === HEIC_UNSUPPORTED || (error instanceof Error && error.name === HEIC_UNSUPPORTED);
            const message = isHeic ? t.errors.HEIC_UNSUPPORTED : getApiErrorMessage(error) || getErrorMessage(error);
            patch(item.key, { status: "failed", error: stop.quota ? fi.quotaStopped : message });
        }
    };

    const run = async (only: (item: ImportItem) => boolean) => {
        const queue = itemsRef.current.filter((item) => item.choice !== SKIP && !item.tooManyPages && only(item));
        if (queue.length === 0) return;
        setRunning(true);
        const stop = { quota: false };
        try {
            await runWithConcurrency(queue, FOLDER_IMPORT_CONCURRENCY, (item) => uploadOne(item, stop));
        } finally {
            setRunning(false);
        }
        const finalItems = itemsRef.current;
        const uploaded = finalItems.filter((item) => item.status === "done" || item.status === "reused").length;
        const failed = finalItems.filter((item) => item.status === "failed").length;
        if (failed > 0) toast.error(fi.finishedWithFailures.replace("{count}", String(uploaded)).replace("{failed}", String(failed)));
        else toast.success(fi.finished.replace("{count}", String(uploaded)));
        onUploaded();
    };

    const setChoice = (item: ImportItem, choice: string) => {
        patch(item.key, { choice, status: choice === SKIP ? "skipped" : item.status === "skipped" ? "ready" : item.status });
    };

    const clear = () => {
        commit([]);
        setIgnored([]);
        setOverflow(0);
        setTooLarge(false);
        keyCache.current.clear();
    };

    const active = items.filter((item) => item.choice !== SKIP && !item.tooManyPages);
    const finishedCount = active.filter((item) => item.status === "done" || item.status === "reused").length;
    const failedCount = active.filter((item) => item.status === "failed").length;
    const readyCount = active.filter((item) => item.status === "ready").length;
    const pageCount = active.reduce((sum, item) => sum + item.pages.length, 0);
    const matchedCount = items.filter((item) => item.autoStudentId).length;
    const studentById = new Map(students.map((student) => [student.id, student]));
    const started = active.some((item) => item.status !== "ready");

    const statusIcon = (status: ItemStatus) => {
        if (status === "compressing" || status === "uploading") return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
        if (status === "done" || status === "reused") return <Check className="h-3.5 w-3.5 text-green-600" />;
        if (status === "failed") return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
        return null;
    };

    return (
        <section className="space-y-3 rounded-xl border p-4" data-testid="folder-import">
            <div className="space-y-1">
                <h3 className="text-sm font-medium">{fi.title}</h3>
                <p className="text-xs text-muted-foreground">{fi.hint}</p>
            </div>
            <input ref={setFolderInput} type="file" multiple className="hidden" data-testid="folder-import-dir" onChange={(event) => onPick(event.currentTarget)} />
            <input ref={filesRef} type="file" multiple accept="image/*,.heic,.heif,image/heic,image/heif" className="hidden" data-testid="folder-import-files" onChange={(event) => onPick(event.currentTarget)} />
            <div
                className={`flex flex-col gap-2 rounded-lg border border-dashed p-3 sm:flex-row sm:flex-wrap sm:items-center ${dragging ? "border-primary bg-primary/10" : "border-primary/40 bg-primary/5"}`}
                onDragOver={(event) => { event.preventDefault(); if (!running) setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
            >
                <Button variant="outline" className="w-full justify-center sm:w-auto" disabled={running || reading} onClick={() => folderRef.current?.click()}><FolderOpen className="h-4 w-4" />{fi.pickFolder}</Button>
                <Button variant="outline" className="w-full justify-center sm:w-auto" disabled={running || reading} onClick={() => filesRef.current?.click()}><Files className="h-4 w-4" />{fi.pickFiles}</Button>
                <span className="text-xs text-muted-foreground">{reading ? fi.reading : fi.dropHere}</span>
            </div>

            {(items.length > 0 || ignored.length > 0) && (
                <div className="space-y-3">
                    <p className="text-sm" data-testid="folder-import-summary">
                        {fi.summary.replace("{papers}", String(active.length)).replace("{pages}", String(pageCount)).replace("{matched}", String(matchedCount))}
                    </p>
                    {overflow > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{fi.overflow.replace("{max}", String(FOLDER_IMPORT_MAX_PAPERS)).replace("{count}", String(overflow))}</p>}
                    {tooLarge && <p className="text-xs text-destructive">{fi.tooLarge.replace("{max}", String(FOLDER_IMPORT_MAX_TOTAL_BYTES / 1024 / 1024 / 1024))}</p>}
                    {ignored.length > 0 && (
                        <details className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                            <summary className="cursor-pointer text-muted-foreground">{fi.ignoredTitle.replace("{count}", String(ignored.length))}</summary>
                            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                                {ignored.map((file) => (
                                    <li key={file.path} className="flex gap-2">
                                        <span className="min-w-0 flex-1 truncate">{file.path}</span>
                                        <span className="shrink-0 text-muted-foreground">{fi.ignoredReason[file.reason].replace("{max}", String(FOLDER_IMPORT_MAX_FILE_BYTES / 1024 / 1024))}</span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}

                    {active.length > 0 && started && (
                        <div className="space-y-1">
                            <Progress value={Math.round(((finishedCount + failedCount) / active.length) * 100)} className="h-2" />
                            <p className="text-xs text-muted-foreground">{fi.progress.replace("{done}", String(finishedCount)).replace("{total}", String(active.length))}</p>
                        </div>
                    )}

                    <ul className="space-y-2">
                        {items.map((item, index) => {
                            const locked = running || item.status === "done" || item.status === "reused" || item.tooManyPages;
                            const busy = item.status === "compressing" || item.status === "uploading";
                            const matched = item.autoStudentId ? studentById.get(item.autoStudentId) : null;
                            return (
                                <li key={item.key} data-testid="folder-import-paper" className={`space-y-2 rounded-lg border p-3 ${item.status === "failed" ? "border-destructive/50" : item.choice === SKIP ? "opacity-60" : ""}`}>
                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                        <span className="font-medium">{t.grading.paperN.replace("{index}", String(index + 1))} · {item.label}</span>
                                        <span className="text-xs text-muted-foreground">{t.grading.live.pages.replace("{count}", String(item.pages.length))}</span>
                                        {matched && item.choice === matched.id && <Badge variant="outline" className="border-primary/40 text-primary">{fi.autoMatched}</Badge>}
                                        {item.alreadySubmitted && item.choice === item.autoStudentId && <Badge variant="outline" className="gap-1 border-amber-500/60 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3 w-3" />{fi.alreadySubmitted}</Badge>}
                                        {item.tooManyPages && <Badge variant="outline" className="border-destructive/50 text-destructive">{fi.tooManyPages.replace("{max}", String(FOLDER_IMPORT_MAX_PAGES))}</Badge>}
                                        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground" data-testid="folder-import-status">
                                            {statusIcon(item.status)}{fi.status[item.status]}
                                        </span>
                                    </div>
                                    {busy && <Progress value={item.status === "compressing" ? 35 : 75} className="h-1.5" />}
                                    {item.status === "failed" && item.error && <p className="text-xs text-destructive">{fi.failed.replace("{error}", item.error)}</p>}
                                    <p className="truncate text-xs text-muted-foreground">{item.pages.map((page) => page.path.split("/").pop()).join("、")}</p>
                                    <NativeSelect aria-label={fi.student} value={item.choice} disabled={locked} onChange={(event) => setChoice(item, event.target.value)}>
                                        <option value="">{fi.aiIdentify}</option>
                                        <option value={SKIP}>{fi.skip}</option>
                                        {students.map((student) => (
                                            <option key={student.id} value={student.id}>{studentLabel(student, multiClass)}{submittedIds.has(student.id) ? " ✓" : ""}</option>
                                        ))}
                                    </NativeSelect>
                                </li>
                            );
                        })}
                    </ul>

                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        {readyCount > 0 && (
                            <Button className="w-full justify-center sm:w-auto" disabled={running || tooLarge} onClick={() => run((item) => item.status === "ready")}>
                                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{fi.start.replace("{count}", String(readyCount))}
                            </Button>
                        )}
                        {failedCount > 0 && !running && (
                            <Button variant="outline" className="w-full justify-center sm:w-auto" onClick={() => run((item) => item.status === "failed")}>
                                <RotateCcw className="h-4 w-4" />{fi.retryFailed.replace("{count}", String(failedCount))}
                            </Button>
                        )}
                        <Button variant="ghost" className="w-full justify-center sm:w-auto" disabled={running} onClick={clear}><X className="h-4 w-4" />{fi.clear}</Button>
                    </div>
                </div>
            )}
        </section>
    );
}
