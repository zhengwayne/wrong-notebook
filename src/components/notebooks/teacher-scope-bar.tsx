"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import type { StoredTeacherScope } from "@/lib/current-child";
import { useActiveLearnerScope } from "@/lib/use-active-learner-scope";

interface RosterStudentItem {
    id: string;
    name: string;
    studentNo?: string | null;
    learnerId?: string | null;
}

interface GradingClassItem {
    id: string;
    name: string;
    students: RosterStudentItem[];
}

export interface TeacherScopeBarProps {
    /** 是否要求必须选到单个学生才对统计面板生效（统计中心展示辅助说明） */
    requireStudentForStats?: boolean;
}

/**
 * 教师身份下的「班级 → 学生」级联筛选条，解决全班几十本错题本平铺混排及统计中心缺学生视角的问题。
 */
export function TeacherScopeBar({ requireStudentForStats = false }: TeacherScopeBarProps) {
    const { t } = useLanguage();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { isTeacher, classId, learnerId, setTeacherScope } = useActiveLearnerScope();
    const [classes, setClasses] = useState<GradingClassItem[]>([]);
    const [classesLoaded, setClassesLoaded] = useState(false);

    useEffect(() => {
        if (!isTeacher) return;
        let cancelled = false;
        apiClient.get<GradingClassItem[]>("/api/grading/classes")
            .then((data) => {
                if (!cancelled) {
                    setClasses(data);
                    setClassesLoaded(true);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setClasses([]);
                    setClassesLoaded(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [isTeacher]);

    const commitScope = useCallback((next: StoredTeacherScope | null) => {
        // 先同步刷新 URL query（并立即同步 window.location），避免事件广播时读回旧的 ?learnerId= 参数引发状态回弹
        if (searchParams.has("learnerId") || searchParams.has("studentKey")) {
            const nextParams = new URLSearchParams(searchParams.toString());
            nextParams.delete("studentKey");
            if (next?.learnerId) nextParams.set("learnerId", next.learnerId);
            else nextParams.delete("learnerId");
            const query = nextParams.toString();
            const targetUrl = query ? `${pathname}?${query}` : pathname;
            if (typeof window !== "undefined") {
                window.history.replaceState(window.history.state, "", targetUrl);
            }
            router.replace(targetUrl, { scroll: false });
        }
        setTeacherScope(next);
    }, [pathname, router, searchParams, setTeacherScope]);

    useEffect(() => {
        // 班级被删除后自动清除失效的班级/学生缓存与 URL 参数，防止错题本页面 404 锁死
        if (!isTeacher || !classesLoaded) return;
        if (classId && !classes.some((cls) => cls.id === classId)) {
            commitScope(null);
        }
    }, [isTeacher, classesLoaded, classId, classes, commitScope]);

    if (!isTeacher || (classes.length === 0 && !classId && !learnerId)) return null;

    const currentClass = classes.find((cls) => cls.id === classId)
        ?? classes.find((cls) => cls.students.some((stu) => stu.learnerId && stu.learnerId === learnerId))
        ?? null;
    const studentsWithLearner = (currentClass?.students ?? []).filter((stu): stu is RosterStudentItem & { learnerId: string } => Boolean(stu.learnerId));
    const labels = t.notebooks.teacherScope;

    const handleClassChange = (nextClassId: string) => {
        if (!nextClassId) {
            commitScope(null);
            return;
        }
        const targetCls = classes.find((cls) => cls.id === nextClassId);
        // 在统计页切换班级时，默认自动选中该班第一位有档案的学生以便立即展示单生统计
        if (requireStudentForStats && targetCls) {
            const firstStu = targetCls.students.find((s) => Boolean(s.learnerId));
            if (firstStu?.learnerId) {
                commitScope({ classId: nextClassId, learnerId: firstStu.learnerId, name: firstStu.name });
                return;
            }
        }
        commitScope({ classId: nextClassId, learnerId: null });
    };

    const handleStudentChange = (nextLearnerId: string) => {
        if (!nextLearnerId) {
            commitScope(currentClass ? { classId: currentClass.id, learnerId: null } : null);
            return;
        }
        const stu = studentsWithLearner.find((s) => s.learnerId === nextLearnerId);
        commitScope({
            classId: currentClass?.id ?? null,
            learnerId: nextLearnerId,
            name: stu?.name,
        });
    };

    return (
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                <Users className="h-4 w-4 text-primary" aria-hidden="true" />
                {labels.label}
            </span>
            <select
                aria-label={labels.label}
                value={currentClass?.id ?? ""}
                onChange={(e) => handleClassChange(e.target.value)}
                className="h-8 rounded-md border bg-background px-2.5 text-sm"
            >
                <option value="">{labels.allClasses}</option>
                {classes.map((cls) => (
                    <option key={cls.id} value={cls.id}>{cls.name}</option>
                ))}
            </select>

            {currentClass && (
                <select
                    aria-label={labels.selectStudent}
                    value={learnerId ?? ""}
                    onChange={(e) => handleStudentChange(e.target.value)}
                    className="h-8 rounded-md border bg-background px-2.5 text-sm"
                >
                    <option value="">{labels.allStudentsInClass}</option>
                    {studentsWithLearner.map((stu) => (
                        <option key={stu.id} value={stu.learnerId}>
                            {stu.studentNo ? `${stu.studentNo} · ${stu.name}` : stu.name}
                        </option>
                    ))}
                </select>
            )}

            {(Boolean(classId) || Boolean(learnerId)) && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => commitScope(null)}
                    className="h-8 px-2 text-xs text-muted-foreground"
                >
                    <X className="mr-1 h-3.5 w-3.5" />
                    {labels.reset}
                </Button>
            )}
        </div>
    );
}
