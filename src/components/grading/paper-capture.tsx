"use client";

import { useRef, useState } from "react";
import { Camera, ChevronRight, Images, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage, getErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { compressPaperImages, groupPages } from "@/lib/use-paper-images";
import type { GradingStudentInfo } from "@/types/grading";

interface Paper {
    images: string[];
    studentId: string;
}

interface PaperCaptureProps {
    taskId: string;
    students: GradingStudentInfo[];
    /** 已交卷的学生，下拉框里排在后面 */
    submittedIds: Set<string>;
    onUploaded: () => void;
}

/**
 * 收卷拍照：连续拍照时每张加到当前这份，点「下一位」开始新的一份；
 * 也可一次选多张照片，按每人页数顺序分组。每份可指定学生或交给 AI 读姓名。
 */
export function PaperCapture({ taskId, students, submittedIds, onUploaded }: PaperCaptureProps) {
    const { t, language } = useLanguage();
    const [papers, setPapers] = useState<Paper[]>([]);
    const [pagesPerPaper, setPagesPerPaper] = useState(1);
    const [busy, setBusy] = useState(false);
    const cameraRef = useRef<HTMLInputElement>(null);
    const pickRef = useRef<HTMLInputElement>(null);

    const used = new Set([...submittedIds, ...papers.map((paper) => paper.studentId).filter(Boolean)]);
    // 默认给下一份选花名册中第一位尚未交卷的学生，老师按收卷顺序拍时基本不用改
    const nextStudentId = () => students.find((student) => !used.has(student.id))?.id || "";

    const addShot = async (files: FileList | null) => {
        if (!files?.length) return;
        const images = await compressPaperImages([...files]);
        setPapers((prev) => {
            if (prev.length === 0) return [{ images, studentId: nextStudentId() }];
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, images: [...last.images, ...images] }];
        });
        if (cameraRef.current) cameraRef.current.value = "";
    };

    const addBatch = async (files: FileList | null) => {
        if (!files?.length) return;
        setBusy(true);
        const ordered = [...files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
        const images = await compressPaperImages(ordered);
        setPapers((prev) => {
            const taken = new Set([...submittedIds, ...prev.map((paper) => paper.studentId).filter(Boolean)]);
            const queue = students.filter((student) => !taken.has(student.id));
            return [...prev, ...groupPages(images, pagesPerPaper).map((group, i) => ({ images: group, studentId: queue[i]?.id || "" }))];
        });
        setBusy(false);
        if (pickRef.current) pickRef.current.value = "";
    };

    const upload = async () => {
        setBusy(true);
        try {
            const result = await apiClient.post<{ ids: string[] }>(`/api/grading/tasks/${taskId}/submissions`, {
                papers: papers.map((paper) => ({ images: paper.images, studentId: paper.studentId || null })),
                language,
            }, { timeout: 180000 });
            toast.success(t.grading.uploaded.replace("{count}", String(result.ids.length)));
            setPapers([]);
            onUploaded();
        } catch (error) {
            toast.error(t.grading.uploadFailed.replace("{error}", getApiErrorMessage(error) || getErrorMessage(error)));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t.grading.captureHint}</p>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => addShot(event.target.files)} />
            <input ref={pickRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => addBatch(event.target.files)} />
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <Button size="lg" onClick={() => cameraRef.current?.click()} disabled={busy}><Camera className="h-5 w-5" />{t.grading.takePhoto}</Button>
                <Button size="lg" variant="outline" disabled={busy || papers.length === 0 || papers[papers.length - 1].images.length === 0}
                    onClick={() => setPapers((prev) => [...prev, { images: [], studentId: nextStudentId() }])}>
                    <ChevronRight className="h-5 w-5" />{t.grading.nextPaper}
                </Button>
                <Button size="lg" variant="outline" onClick={() => pickRef.current?.click()} disabled={busy}><Images className="h-5 w-5" />{t.grading.pickPhotos}</Button>
                <div className="flex items-center gap-2">
                    <Label htmlFor="grading-pages" className="shrink-0 text-sm">{t.grading.pagesPerPaper}</Label>
                    <Input id="grading-pages" type="number" min={1} max={8} className="w-20" value={pagesPerPaper}
                        onChange={(event) => setPagesPerPaper(Math.min(8, Math.max(1, Number(event.target.value) || 1)))} />
                </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {papers.map((paper, index) => (
                    <div key={index} className="space-y-2 rounded-xl border p-3">
                        <div className="flex items-center justify-between text-sm font-medium">
                            <span>{t.grading.paperN.replace("{index}", String(index + 1))} · {t.grading.pageCount.replace("{count}", String(paper.images.length))}</span>
                            <Button variant="ghost" size="icon" aria-label={t.grading.removePaper} onClick={() => setPapers((prev) => prev.filter((_, i) => i !== index))}>
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                        <div className="flex gap-1 overflow-x-auto">
                            {paper.images.map((image, page) => (
                                 
                                <img key={page} src={image} alt="" className="h-24 w-auto rounded border object-cover" />
                            ))}
                        </div>
                        <NativeSelect aria-label={t.grading.student} value={paper.studentId}
                            onChange={(event) => setPapers((prev) => prev.map((item, i) => (i === index ? { ...item, studentId: event.target.value } : item)))}>
                            <option value="">{t.grading.autoName}</option>
                            {students.map((student) => (
                                <option key={student.id} value={student.id}>{student.name}{submittedIds.has(student.id) ? " ✓" : ""}</option>
                            ))}
                        </NativeSelect>
                    </div>
                ))}
            </div>

            {papers.length > 0 && (
                <Button size="lg" className="w-full sm:w-auto" onClick={upload} disabled={busy || papers.some((paper) => paper.images.length === 0)}>
                    {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                    {busy ? t.grading.uploading : t.grading.uploadAndGrade.replace("{count}", String(papers.length))}
                </Button>
            )}
        </div>
    );
}
