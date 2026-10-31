"use client";

import { useState } from "react";
import { Plus, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RosterImport } from "@/components/grading/roster-import";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog, toast } from "@/lib/feedback";
import type { GradingClassInfo } from "@/types/grading";

interface ClassManagerProps {
    classes: GradingClassInfo[];
    onChange: (classes: GradingClassInfo[]) => void;
}

/** 班级与名册：导入（班级、学号、姓名）、查看与移除学生、新建与删除班级 */
export function ClassManager({ classes, onChange }: ClassManagerProps) {
    const { t } = useLanguage();
    const r = t.grading.roster;
    const [name, setName] = useState("");
    const [open, setOpen] = useState<string | null>(null);

    const reload = () => apiClient.get<GradingClassInfo[]>("/api/grading/classes").then(onChange).catch(() => undefined);

    const addClass = async () => {
        if (!name.trim()) return;
        try {
            const created = await apiClient.post<GradingClassInfo>("/api/grading/classes", { name });
            onChange([...classes, created]);
            setName("");
        } catch (error) {
            toast.error(error);
        }
    };

    const removeClass = async (id: string) => {
        if (!(await confirmDialog(t.grading.confirmDeleteClass, { destructive: true }))) return;
        await apiClient.delete(`/api/grading/classes/${id}`);
        onChange(classes.filter((item) => item.id !== id));
    };

    const removeStudent = async (id: string) => {
        if (!(await confirmDialog(r.confirmDeleteStudent, { destructive: true }))) return;
        await apiClient.delete(`/api/grading/students/${id}`);
        reload();
    };

    return (
        <Card className="rounded-2xl">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg"><Users className="h-5 w-5 text-primary" />{t.grading.classes}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {classes.map((item) => (
                    <div key={item.id} className="space-y-2 rounded-xl border p-3">
                        <div className="flex items-center justify-between gap-2">
                            <button type="button" className="min-w-0 text-left font-medium hover:text-primary" onClick={() => setOpen(open === item.id ? null : item.id)}>
                                {item.name}
                                <span className="ml-2 text-xs text-muted-foreground">{t.grading.studentCount.replace("{count}", String(item.students.length))} · {open === item.id ? r.hideStudents : r.showStudents}</span>
                            </button>
                            <Button variant="ghost" size="icon" aria-label={t.grading.deleteClass} onClick={() => removeClass(item.id)}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                        {open === item.id && (
                            <div className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
                                {item.students.map((student) => (
                                    <div key={student.id} className="flex items-center gap-2 px-2 py-1">
                                        <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{student.studentNo || "—"}</span>
                                        <span className="flex-1 truncate">{student.name}</span>
                                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={r.deleteStudent} onClick={() => removeStudent(student.id)}><X className="h-3.5 w-3.5" /></Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
                <RosterImport onImported={reload} />
                <div className="flex gap-2">
                    <Input aria-label={t.grading.className} placeholder={t.grading.className} value={name} onChange={(event) => setName(event.target.value)} />
                    <Button variant="outline" onClick={addClass} disabled={!name.trim()}><Plus className="h-4 w-4" />{t.grading.addClass}</Button>
                </div>
            </CardContent>
        </Card>
    );
}
