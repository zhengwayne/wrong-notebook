"use client";

import { useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { confirmDialog, toast } from "@/lib/feedback";
import type { GradingClassInfo } from "@/types/grading";

interface ClassManagerProps {
    classes: GradingClassInfo[];
    onChange: (classes: GradingClassInfo[]) => void;
}

/** 班级与花名册：新建班级、粘贴学生名单、修改与删除 */
export function ClassManager({ classes, onChange }: ClassManagerProps) {
    const { t } = useLanguage();
    const [name, setName] = useState("");
    const [roster, setRoster] = useState("");
    const [editing, setEditing] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);

    const addClass = async () => {
        if (!name.trim()) return;
        setBusy(true);
        try {
            const created = await apiClient.post<GradingClassInfo>("/api/grading/classes", { name, roster });
            onChange([...classes, created]);
            setName("");
            setRoster("");
        } catch (error) {
            toast.error(error);
        } finally {
            setBusy(false);
        }
    };

    const saveRoster = async (id: string) => {
        try {
            const updated = await apiClient.put<GradingClassInfo>(`/api/grading/classes/${id}`, { roster: editing[id] });
            onChange(classes.map((item) => (item.id === id ? updated : item)));
            setEditing(({ [id]: _removed, ...rest }) => rest);
        } catch (error) {
            toast.error(error);
        }
    };

    const removeClass = async (id: string) => {
        if (!(await confirmDialog(t.grading.confirmDeleteClass, { destructive: true }))) return;
        await apiClient.delete(`/api/grading/classes/${id}`);
        onChange(classes.filter((item) => item.id !== id));
    };

    return (
        <Card className="rounded-2xl">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg"><Users className="h-5 w-5 text-primary" />{t.grading.classes}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {classes.map((item) => (
                    <div key={item.id} className="space-y-2 rounded-xl border p-3">
                        <div className="flex items-center justify-between gap-2">
                            <button type="button" className="text-left font-medium hover:text-primary"
                                onClick={() => setEditing((prev) => ({ ...prev, [item.id]: item.students.map((s) => s.name).join("\n") }))}>
                                {item.name}
                                <span className="ml-2 text-xs text-muted-foreground">{t.grading.studentCount.replace("{count}", String(item.students.length))}</span>
                            </button>
                            <Button variant="ghost" size="icon" aria-label={t.grading.deleteClass} onClick={() => removeClass(item.id)}>
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                        {editing[item.id] !== undefined ? (
                            <div className="space-y-2">
                                <Textarea rows={5} value={editing[item.id]} aria-label={t.grading.roster}
                                    onChange={(event) => setEditing((prev) => ({ ...prev, [item.id]: event.target.value }))} />
                                <Button size="sm" onClick={() => saveRoster(item.id)}>{t.grading.saveRoster}</Button>
                            </div>
                        ) : (
                            <p className="line-clamp-2 text-xs text-muted-foreground">{item.students.map((s) => s.name).join("、")}</p>
                        )}
                    </div>
                ))}
                <div className="space-y-2 rounded-xl border border-dashed p-3">
                    <Label htmlFor="grading-class-name">{t.grading.className}</Label>
                    <Input id="grading-class-name" value={name} onChange={(event) => setName(event.target.value)} />
                    <Label htmlFor="grading-class-roster">{t.grading.roster}</Label>
                    <Textarea id="grading-class-roster" rows={4} value={roster} onChange={(event) => setRoster(event.target.value)} />
                    <Button onClick={addClass} disabled={busy || !name.trim()}><Plus className="h-4 w-4" />{t.grading.addClass}</Button>
                </div>
            </CardContent>
        </Card>
    );
}
