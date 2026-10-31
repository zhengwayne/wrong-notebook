"use client";

import { AlertTriangle, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/grading/native-select";
import { useLanguage } from "@/contexts/LanguageContext";
import { identityLabel, studentLabel } from "@/lib/grading-labels";
import type { GradingMatchInfo, GradingStudentInfo } from "@/types/grading";

interface MatchPanelProps {
    info: GradingMatchInfo;
    studentId: string | null;
    students: GradingStudentInfo[];
    multiClass: boolean;
    /** 已有答卷的学生 */
    takenIds: Set<string>;
    disabled?: boolean;
    onAssign: (studentId: string) => void;
}

/** 卷头匹配结果：卷面读到的信息、原因、置信度，以及一键分配的候选学生 */
export function MatchPanel({ info, studentId, students, multiClass, takenIds, disabled, onAssign }: MatchPanelProps) {
    const { t } = useLanguage();
    const m = t.grading.match;
    const byId = new Map(students.map((student) => [student.id, student]));
    const detected = identityLabel({ className: info.detectedClass, studentNo: info.detectedStudentNo, name: info.detectedName });
    const review = info.matchStatus === "review" || !studentId;
    const candidates = info.matchCandidates.filter((item) => item.studentId !== studentId && byId.has(item.studentId));

    return (
        <div className={`space-y-2 rounded-lg p-2 text-xs ${review ? "bg-amber-500/10" : "bg-muted/50"}`}>
            <div className="flex flex-wrap items-center gap-1.5">
                {info.matchStatus && (
                    <Badge variant="outline" className={review ? "gap-1 border-amber-500/60 text-amber-700 dark:text-amber-400" : "gap-1"}>
                        {review ? <AlertTriangle className="h-3 w-3" /> : <UserCheck className="h-3 w-3" />}{m.status[review ? "review" : info.matchStatus]}
                    </Badge>
                )}
                <span className="text-muted-foreground">{detected ? m.detected.replace("{info}", detected) : m.nothingDetected}</span>
            </div>
            {info.matchReason && (
                <p>
                    {m.reason[info.matchReason.code]}
                    {info.matchConfidence !== null && info.matchStatus !== "manual" && ` · ${m.confidence.replace("{value}", String(Math.round(info.matchConfidence * 100)))}`}
                    {info.matchReason.studentNoUnmatched && ` ${m.studentNoUnmatched}`}
                </p>
            )}
            {review && candidates.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">{m.candidates}</span>
                    {candidates.map((item) => {
                        const student = byId.get(item.studentId);
                        if (!student) return null;
                        return (
                            <Button key={item.studentId} size="sm" variant="secondary" className="h-8" disabled={disabled}
                                onClick={(event) => { event.preventDefault(); onAssign(item.studentId); }}>
                                {studentLabel(student, multiClass)}
                                <span className="text-muted-foreground">{Math.round(item.confidence * 100)}%{takenIds.has(item.studentId) ? ` · ${m.alreadyHas}` : ""}</span>
                            </Button>
                        );
                    })}
                </div>
            )}
            {review && (
                <NativeSelect aria-label={m.otherStudent} className="h-9" value="" disabled={disabled}
                    onChange={(event) => event.target.value && onAssign(event.target.value)}>
                    <option value="">{m.otherStudent}</option>
                    {students.map((student) => (
                        <option key={student.id} value={student.id}>{studentLabel(student, multiClass)}{takenIds.has(student.id) ? " ✓" : ""}</option>
                    ))}
                </NativeSelect>
            )}
        </div>
    );
}
