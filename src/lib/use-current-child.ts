"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
    childIdFromSearchParams,
    isUsableChildId,
    readStoredChild,
    readStoredTeacherScope,
    withChildParam,
    writeStoredChild,
    writeStoredTeacherScope,
    type StoredChild,
    type StoredTeacherScope,
} from "@/lib/current-child";

function childFromWindow(): StoredChild | null {
    if (typeof window === "undefined") return null;
    const id = childIdFromSearchParams(new URLSearchParams(window.location.search));
    return id ? { id } : null;
}

function readInitialChild(userId?: string | null): StoredChild | null {
    if (typeof window === "undefined") return null;
    const fromUrl = childFromWindow();
    const fromStore = readStoredChild(userId);
    if (fromUrl) {
        const merged: StoredChild = {
            id: fromUrl.id,
            name: fromStore?.id === fromUrl.id ? fromStore.name : undefined,
        };
        if (userId) writeStoredChild(merged, userId);
        return merged;
    }
    return fromStore;
}

/**
 * 家长/教师身份下记住当前选中的学习者（孩子或班级学生），并给链接带上 learnerId / studentKey。
 * 按 userId 隔离 localStorage，并通过自定义事件在同一页面的筛选栏与统计组件之间实时同步。
 */
export function useCurrentChild() {
    const { data: session } = useSession();
    const pathname = usePathname();
    const userId = session?.user?.id ?? null;
    const activePersona = session?.user?.activePersona ?? null;
    const isParent = activePersona === "parent";
    const isTeacher = activePersona === "teacher";

    const [child, setChild] = useState<StoredChild | null>(() => readInitialChild(userId));
    const [teacherScope, setTeacherScopeState] = useState<StoredTeacherScope | null>(() => readStoredTeacherScope(userId));

    useEffect(() => {
        const sync = () => {
            const fromUrl = childFromWindow();
            if (isTeacher) {
                const stored = readStoredTeacherScope(userId);
                if (fromUrl) {
                    const next: StoredTeacherScope = {
                        classId: stored?.classId ?? null,
                        learnerId: fromUrl.id,
                        name: stored?.learnerId === fromUrl.id ? stored.name : undefined,
                    };
                    setTeacherScopeState(next);
                } else {
                    setTeacherScopeState(stored);
                }
                return;
            }
            const fromStore = readStoredChild(userId);
            if (fromUrl) {
                const merged: StoredChild = {
                    id: fromUrl.id,
                    name: fromStore?.id === fromUrl.id ? fromStore.name : undefined,
                };
                writeStoredChild(merged, userId);
                setChild(merged);
                return;
            }
            setChild(fromStore);
        };
        sync();
        if (typeof window !== "undefined") {
            window.addEventListener("xueji:learner-scope-change", sync);
            return () => window.removeEventListener("xueji:learner-scope-change", sync);
        }
        return undefined;
    }, [pathname, userId, isTeacher]);

    const setLearner = useCallback((next: StoredChild | string | null, name?: string) => {
        const stored: StoredChild | null = typeof next === "string"
            ? (isUsableChildId(next) ? { id: next, name } : null)
            : next;
        writeStoredChild(stored, userId);
        setChild(stored);
        if (typeof window !== "undefined" && typeof CustomEvent === "function") {
            window.dispatchEvent(new CustomEvent("xueji:learner-scope-change"));
        }
    }, [userId]);

    const setTeacherScope = useCallback((next: StoredTeacherScope | null) => {
        writeStoredTeacherScope(next, userId);
        setTeacherScopeState(next);
    }, [userId]);

    const learnerId = isParent
        ? (child ? child.id : null)
        : (isTeacher ? (teacherScope?.learnerId ?? null) : null);

    const activeName = isParent ? child?.name : (isTeacher ? teacherScope?.name : undefined);
    const classId = isTeacher ? (teacherScope?.classId ?? null) : null;

    const hrefWithChild = useCallback((href: string) => withChildParam(href, learnerId), [learnerId]);

    return {
        isParent,
        isTeacher,
        classId,
        learnerId,
        childName: activeName,
        setLearner,
        setTeacherScope,
        hrefWithChild,
    };
}
