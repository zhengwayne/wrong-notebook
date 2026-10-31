"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, Check, CheckCheck, Images, Loader2, Scissors, Trash2, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { identityLabel, studentLabel } from "@/lib/grading-labels";
import { groupCapturedPages, type CapturedPage, type GroupedPaper } from "@/lib/page-grouping";
import { compressPaperImages } from "@/lib/use-paper-images";
import type { GradingStudentInfo, IdentifyResponse } from "@/types/grading";

interface ShotPage extends CapturedPage {
    image: string;
}

interface PaperCaptureProps {
    taskId: string;
    students: GradingStudentInfo[];
    /** 已交卷的学生，下拉框中标记 ✓ */
    submittedIds: Set<string>;
    /** 任务是否跨多个班（决定学生名前是否显示班级） */
    multiClass: boolean;
    onUploaded: () => void;
}

/**
 * 收卷拍照：每拍一张立即在后台读卷头（班级/学号/姓名）并匹配名册；
 * 没有身份的页自动接到上一份，读到新身份就开始新的一份。
 * 一份定稿（下一份已开始或点「完成」）后自动上传判分。老师可随时拆分、并入或改学生。
 */
export function PaperCapture({ taskId, students, submittedIds, multiClass, onUploaded }: PaperCaptureProps) {
    const { t, language } = useLanguage();
    const live = t.grading.live;
    const [pages, setPages] = useState<ShotPage[]>([]);
    const [finished, setFinished] = useState(false);
    const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set());
    const [failedUploadIds, setFailedUploadIds] = useState<Set<string>>(new Set());
    const [uploadedCount, setUploadedCount] = useState(0);
    const counter = useRef(0);
    // 同步记录正在上传的页，避免严格模式下副作用重复执行导致重复上传
    const inflight = useRef<Set<string>>(new Set());
    const cameraRef = useRef<HTMLInputElement>(null);
    const pickRef = useRef<HTMLInputElement>(null);
    const studentById = new Map(students.map((student) => [student.id, student]));

    const papers = groupCapturedPages(pages, finished);

    const updatePage = (id: string, patch: Partial<ShotPage>) =>
        setPages((prev) => prev.map((page) => (page.id === id ? { ...page, ...patch } : page)));

    // 后台读卷头
    const identify = async (page: ShotPage) => {
        try {
            const result = await apiClient.post<IdentifyResponse>(`/api/grading/tasks/${taskId}/identify`, { image: page.image, language }, { timeout: 90000 });
            updatePage(page.id, { status: "read", identity: result.identity, match: result.match });
        } catch {
            updatePage(page.id, { status: "failed", identity: null, match: null });
        }
    };

    const addFiles = async (files: FileList | null, input: HTMLInputElement | null) => {
        if (!files?.length) return;
        // 批量选择时按拍摄时间、文件名排序，保证正反面顺序
        const ordered = [...files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name, undefined, { numeric: true }));
        const images = await compressPaperImages(ordered);
        const added: ShotPage[] = images.map((image) => ({ id: `p${++counter.current}`, status: "reading", image }));
        setFinished(false);
        setPages((prev) => [...prev, ...added]);
        if (input) input.value = "";
        for (const page of added) void identify(page);
    };

    // 定稿的一份自动上传；上传过程中的页不重复上传，失败的等老师点「完成」重试
    useEffect(() => {
        const ready = papers.filter((paper) => paper.settled && !paper.pageIds.some((id) => inflight.current.has(id) || failedUploadIds.has(id)));
        if (ready.length === 0) return;
        const ids = ready.flatMap((paper) => paper.pageIds);
        ids.forEach((id) => inflight.current.add(id));
        const send = async () => {
            setUploadingIds((prev) => new Set([...prev, ...ids]));
            const pageById = new Map(pages.map((page) => [page.id, page]));
            try {
                const result = await apiClient.post<{ ids: string[] }>(`/api/grading/tasks/${taskId}/submissions`, {
                    papers: ready.map((paper) => ({
                        images: paper.pageIds.map((id) => pageById.get(id)?.image || ""),
                        // 只有老师手动指定的学生直接采用；其余由服务端按卷头重新匹配
                        studentId: paper.manual ? paper.studentId : null,
                        identity: paper.identity,
                    })),
                    language,
                }, { timeout: 180000 });
                setPages((prev) => prev.filter((page) => !ids.includes(page.id)));
                setUploadedCount((count) => count + result.ids.length);
                onUploaded();
            } catch (error) {
                setFailedUploadIds((prev) => new Set([...prev, ...ids]));
                toast.error(t.grading.uploadFailed.replace("{error}", getApiErrorMessage(error) || getErrorMessage(error)));
            } finally {
                ids.forEach((id) => inflight.current.delete(id));
                setUploadingIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
            }
        };
        void send();
    }, [papers, pages, uploadingIds, failedUploadIds, taskId, language, onUploaded, t]);

    const finish = () => {
        setFailedUploadIds(new Set());
        setFinished(true);
    };

    const assign = (paper: GroupedPaper, studentId: string) => updatePage(paper.pageIds[0], { assignStudentId: studentId || null });

    const paperTitle = (paper: GroupedPaper) => {
        const student = paper.studentId ? studentById.get(paper.studentId) : null;
        if (student) return studentLabel(student, multiClass);
        return identityLabel(paper.identity) || live.unknown;
    };

    const pending = pages.length > 0;
    const busyUpload = uploadingIds.size > 0;

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{live.hint}</p>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => addFiles(event.target.files, cameraRef.current)} />
            <input ref={pickRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => addFiles(event.target.files, pickRef.current)} />
            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
                <Button size="lg" onClick={() => cameraRef.current?.click()}><Camera className="h-5 w-5" />{t.grading.takePhoto}</Button>
                <Button size="lg" variant="outline" onClick={() => pickRef.current?.click()}><Images className="h-5 w-5" />{t.grading.pickPhotos}</Button>
                <Button size="lg" variant="secondary" onClick={finish} disabled={!pending}><CheckCheck className="h-5 w-5" />{live.done}</Button>
            </div>
            {(busyUpload || uploadedCount > 0) && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    {busyUpload ? <><Loader2 className="h-4 w-4 animate-spin" />{live.uploading}</> : <><Check className="h-4 w-4 text-green-600" />{live.uploadedCount.replace("{count}", String(uploadedCount))}</>}
                </p>
            )}

            {pending && <h3 className="text-sm font-medium">{live.title.replace("{count}", String(pages.length))}</h3>}
            <div className="space-y-3">
                {papers.map((paper, index) => {
                    const uploading = paper.pageIds.some((id) => uploadingIds.has(id));
                    const firstPage = pages.find((page) => page.id === paper.pageIds[0]);
                    return (
                        <div key={paper.pageIds[0]} className={`space-y-2 rounded-xl border p-3 ${paper.flags.includes("needs_review") ? "border-amber-500/60 bg-amber-500/5" : ""}`}>
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-medium">{t.grading.paperN.replace("{index}", String(index + 1))} · {paperTitle(paper)}</span>
                                <span className="text-xs text-muted-foreground">{live.pages.replace("{count}", String(paper.pageIds.length))}</span>
                                {paper.flags.map((flag) => (
                                    <Badge key={flag} variant="outline" className="gap-1 border-amber-500/60 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3 w-3" />{live.flag[flag]}</Badge>
                                ))}
                                <span className="ml-auto text-xs text-muted-foreground">
                                    {uploading ? live.uploading : paper.settled ? "" : live.waiting}
                                </span>
                            </div>
                            <div className="flex gap-2 overflow-x-auto pb-1">
                                {paper.pageIds.map((id, pageIndex) => {
                                    const page = pages.find((item) => item.id === id);
                                    if (!page) return null;
                                    return (
                                        <div key={id} className="w-28 shrink-0 space-y-1">
                                            <div className="relative">
                                                <img src={page.image} alt="" className="h-32 w-28 rounded border object-cover" />
                                                <span className="absolute inset-x-0 bottom-0 truncate rounded-b bg-black/60 px-1 text-[10px] text-white">
                                                    {page.status === "reading" ? live.reading : page.status === "failed" ? live.failed
                                                        : identityLabel(page.identity) || live.continuation}
                                                </span>
                                            </div>
                                            <div className="flex gap-1">
                                                {pageIndex > 0 && (
                                                    <Button variant="outline" size="icon" className="h-7 w-7" aria-label={live.newHere} title={live.newHere}
                                                        disabled={uploading} onClick={() => updatePage(id, { manualBreak: "new" })}><Scissors className="h-3.5 w-3.5" /></Button>
                                                )}
                                                {pageIndex === 0 && index > 0 && (
                                                    <Button variant="outline" size="icon" className="h-7 w-7" aria-label={live.joinPrev} title={live.joinPrev}
                                                        disabled={uploading || papers[index - 1].pageIds.some((pid) => uploadingIds.has(pid))}
                                                        onClick={() => updatePage(id, { manualBreak: "continue" })}><Undo2 className="h-3.5 w-3.5" /></Button>
                                                )}
                                                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={live.removePage} title={live.removePage}
                                                    disabled={uploading} onClick={() => setPages((prev) => prev.filter((item) => item.id !== id))}><Trash2 className="h-3.5 w-3.5" /></Button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <NativeSelect aria-label={live.assign} value={firstPage?.assignStudentId || paper.studentId || ""} disabled={uploading}
                                onChange={(event) => assign(paper, event.target.value)}>
                                <option value="">{live.unknown}</option>
                                {students.map((student) => (
                                    <option key={student.id} value={student.id}>{studentLabel(student, multiClass)}{submittedIds.has(student.id) ? " ✓" : ""}</option>
                                ))}
                            </NativeSelect>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
