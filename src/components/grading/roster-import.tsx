"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/feedback";
import { readXlsxRows } from "@/lib/xlsx-rows";
import type { RosterAction, RosterImportPreview } from "@/types/grading";

interface RosterImportProps {
    onImported: () => void;
}

const ACTION_VARIANT: Record<RosterAction, "default" | "secondary" | "outline"> = { create: "default", update: "secondary", unchanged: "outline" };

/** 导入名册：粘贴表格或选择 CSV / Excel，先预览新增、更新、重复和错误，再确认写入 */
export function RosterImport({ onImported }: RosterImportProps) {
    const { t } = useLanguage();
    const r = t.grading.roster;
    const [text, setText] = useState("");
    const [rows, setRows] = useState<string[][] | null>(null);
    const [fileName, setFileName] = useState("");
    const [defaultClassName, setDefaultClassName] = useState("");
    const [preview, setPreview] = useState<RosterImportPreview | null>(null);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const payload = () => (rows ? { rows } : { text });

    const loadFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            if (/\.xlsx$/i.test(file.name)) {
                setRows(await readXlsxRows(file));
                setText("");
            } else {
                setText(await file.text());
                setRows(null);
            }
            setFileName(file.name);
            setPreview(null);
        } catch {
            toast.error(r.fileFailed);
        }
        if (fileRef.current) fileRef.current.value = "";
    };

    const run = async (commit: boolean) => {
        setBusy(true);
        try {
            const result = await apiClient.post<RosterImportPreview>("/api/grading/roster/import", { ...payload(), defaultClassName, commit });
            if (commit) {
                toast.success(r.done.replace("{create}", String(result.counts.create)).replace("{update}", String(result.counts.update)));
                setPreview(null);
                setText("");
                setRows(null);
                setFileName("");
                onImported();
            } else {
                setPreview(result);
            }
        } catch (error) {
            toast.error(error);
        } finally {
            setBusy(false);
        }
    };

    const changes = preview ? preview.counts.create + preview.counts.update : 0;

    return (
        <div className="space-y-3 rounded-xl border border-dashed p-3">
            <div className="flex items-center gap-2 font-medium"><FileSpreadsheet className="h-4 w-4 text-primary" />{r.importTitle}</div>
            <p className="text-xs text-muted-foreground">{r.importHint}</p>
            <Textarea rows={4} aria-label={r.paste} placeholder={r.pastePlaceholder} value={rows ? "" : text} disabled={!!rows}
                className="font-mono text-xs" onChange={(event) => { setText(event.target.value); setPreview(null); }} />
            <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xlsx,text/csv" className="hidden" onChange={(event) => loadFile(event.target.files?.[0])} />
            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />{r.chooseFile}</Button>
                {fileName && <span className="truncate text-xs text-muted-foreground">{fileName}</span>}
            </div>
            <div className="space-y-1">
                <Label htmlFor="roster-default-class" className="text-xs">{r.defaultClass}</Label>
                <Input id="roster-default-class" value={defaultClassName} onChange={(event) => { setDefaultClassName(event.target.value); setPreview(null); }} />
            </div>
            <Button type="button" size="sm" variant="secondary" disabled={busy || (!text.trim() && !rows)} onClick={() => run(false)}>
                {busy && !preview && <Loader2 className="h-4 w-4 animate-spin" />}{r.preview}
            </Button>

            {preview && (
                <div className="space-y-2 text-sm">
                    <p className="font-medium">{r.counts.replace("{create}", String(preview.counts.create)).replace("{update}", String(preview.counts.update)).replace("{unchanged}", String(preview.counts.unchanged))}</p>
                    {preview.newClasses.length > 0 && <p className="text-xs text-muted-foreground">{r.newClasses.replace("{names}", preview.newClasses.join("、"))}</p>}
                    <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
                        {preview.rows.map((row) => (
                            <div key={row.line} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                                <span className="w-8 shrink-0 text-muted-foreground">{row.line}</span>
                                <span className="min-w-0 flex-1 truncate">{row.className} · {row.studentNo || "—"} · <span className="font-medium">{row.name}</span>
                                    {row.action === "update" && <span className="text-muted-foreground"> （{r.was.replace("{info}", [row.previousStudentNo, row.previousName].filter(Boolean).join(" "))}）</span>}
                                </span>
                                <Badge variant={ACTION_VARIANT[row.action]}>{r.action[row.action]}</Badge>
                            </div>
                        ))}
                    </div>
                    {preview.duplicates.length > 0 && (
                        <details className="rounded-lg bg-amber-500/10 p-2 text-xs" open>
                            <summary>{r.duplicatesTitle.replace("{count}", String(preview.duplicates.length))}</summary>
                            {preview.duplicates.map((item) => (
                                <p key={item.line}>{r.duplicateLine.replace("{line}", String(item.line)).replace("{first}", String(item.firstLine)).replace("{info}", [item.className, item.studentNo, item.name].filter(Boolean).join(" "))}</p>
                            ))}
                        </details>
                    )}
                    {preview.errors.length > 0 && (
                        <details className="rounded-lg bg-destructive/10 p-2 text-xs" open>
                            <summary>{r.errorsTitle.replace("{count}", String(preview.errors.length))}</summary>
                            {preview.errors.map((item) => <p key={item.line}>{r.line.replace("{line}", String(item.line))}：{r.issue[item.code]}</p>)}
                        </details>
                    )}
                    {preview.rows.length === 0 ? <p className="text-destructive">{r.noRows}</p> : (
                        <Button type="button" className="w-full" disabled={busy || changes === 0} onClick={() => run(true)}>
                            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{r.commit.replace("{count}", String(changes))}
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}
