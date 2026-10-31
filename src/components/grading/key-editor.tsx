"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import { totalScore } from "@/lib/grading";
import { compressPaperImages } from "@/lib/use-paper-images";
import type { KeyQuestionInput } from "@/types/grading";

interface KeyEditorProps {
    taskId: string;
    initial: KeyQuestionInput[];
    onSaved: () => void;
}

const splitList = (value: string, separator: RegExp) => value.split(separator).map((item) => item.trim()).filter(Boolean);

/** 标准答案编辑：逐题修改题号、题型、分值、答案；可拍答案卷让 AI 识别后再核对 */
export function KeyEditor({ taskId, initial, onSaved }: KeyEditorProps) {
    const { t, language } = useLanguage();
    const [rows, setRows] = useState<KeyQuestionInput[]>(initial);
    const [reading, setReading] = useState(false);
    const [saving, setSaving] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const update = (index: number, patch: Partial<KeyQuestionInput>) => {
        setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    };

    const readPhoto = async (files: FileList | null) => {
        if (!files?.length) return;
        setReading(true);
        try {
            const images = await compressPaperImages([...files]);
            const result = await apiClient.post<{ questions: KeyQuestionInput[] }>(`/api/grading/tasks/${taskId}/key-image`, { images, language }, { timeout: 180000 });
            setRows(result.questions);
            toast.success(t.grading.readKeyDone.replace("{count}", String(result.questions.length)));
        } catch {
            toast.error(t.grading.readKeyFailed);
        } finally {
            setReading(false);
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    const save = async () => {
        setSaving(true);
        try {
            await apiClient.put(`/api/grading/tasks/${taskId}`, { questions: rows });
            toast.success(t.grading.keySaved);
            onSaved();
        } catch (error) {
            toast.error(error);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => readPhoto(event.target.files)} />
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={reading}>
                    {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                    {reading ? t.grading.readingKey : t.grading.readKeyPhoto}
                </Button>
                <span className="text-sm text-muted-foreground">{t.grading.fullScore.replace("{score}", String(totalScore(rows.map((row) => ({ score: row.maxScore })))))}</span>
            </div>
            <div className="space-y-2">
                {rows.map((row, index) => (
                    <div key={index} className="grid grid-cols-[3.5rem_1fr_4.5rem_auto] items-start gap-2 rounded-xl border p-2 sm:grid-cols-[4rem_7rem_5rem_1fr_auto]">
                        <Input aria-label={t.grading.number} value={row.number} onChange={(event) => update(index, { number: event.target.value })} />
                        <NativeSelect aria-label={t.grading.type} value={row.type} className="col-span-1"
                            onChange={(event) => update(index, { type: event.target.value === "subjective" ? "subjective" : "objective" })}>
                            <option value="objective">{t.grading.objective}</option>
                            <option value="subjective">{t.grading.subjective}</option>
                        </NativeSelect>
                        <Input aria-label={t.grading.maxScore} type="number" min={0} step={0.5} value={row.maxScore}
                            onChange={(event) => update(index, { maxScore: Number(event.target.value) || 0 })} />
                        <div className="col-span-4 space-y-1 sm:col-span-1">
                            <Input aria-label={t.grading.answer} placeholder={t.grading.answer} value={row.answer} onChange={(event) => update(index, { answer: event.target.value })} />
                            {row.type === "objective" && (
                                <Input aria-label={t.grading.alternatives} placeholder={t.grading.alternatives} value={(row.acceptedAnswers || []).join(" | ")}
                                    onChange={(event) => update(index, { acceptedAnswers: splitList(event.target.value, /\|/) })} />
                            )}
                            <Input aria-label={t.grading.knowledgePoints} placeholder={t.grading.knowledgePoints} value={(row.knowledgePoints || []).join(", ")}
                                onChange={(event) => update(index, { knowledgePoints: splitList(event.target.value, /[,，]/).slice(0, 5) })} />
                        </div>
                        <Button variant="ghost" size="icon" className="col-start-4 row-start-1 sm:col-start-auto" aria-label={t.grading.removeQuestion}
                            onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}>
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                ))}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setRows((prev) => [...prev, { number: String(prev.length + 1), type: "objective", maxScore: prev.at(-1)?.maxScore ?? 1, answer: "" }])}>
                    <Plus className="h-4 w-4" />{t.grading.addQuestion}
                </Button>
                <Button onClick={save} disabled={saving || rows.some((row) => !row.number.trim())}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{t.grading.saveKey}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t.grading.keyChangedWarning}</p>
        </div>
    );
}
