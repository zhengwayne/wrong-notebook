/**
 * 家长身份下当前选中的孩子。
 * URL 参数优先（learnerId，学习路径页也接受 studentKey），并写入 localStorage，方便跨页面保留选择。
 */
import { SELF_STUDENT_KEY } from "@/lib/learning-path/types";

export const CURRENT_CHILD_STORAGE_KEY = "xueji.currentChildLearner";
export const TEACHER_SCOPE_STORAGE_KEY = "xueji.teacherLearnerScope";

/** 按 userId 生成隔离的 localStorage 键，防止同一浏览器切换账号后读取前一账号的孩子选择 */
export function currentChildStorageKey(userId?: string | null): string {
    const trimmed = userId?.trim();
    return trimmed ? `${CURRENT_CHILD_STORAGE_KEY}:${trimmed}` : CURRENT_CHILD_STORAGE_KEY;
}

/** 按 userId 隔离教师端选中的班级与学生作用域 */
export function teacherScopeStorageKey(userId?: string | null): string {
    const trimmed = userId?.trim();
    return trimmed ? `${TEACHER_SCOPE_STORAGE_KEY}:${trimmed}` : TEACHER_SCOPE_STORAGE_KEY;
}

export interface StoredChild {
    id: string;
    name?: string;
}

export interface StoredTeacherScope {
    classId: string | null;
    learnerId: string | null;
    name?: string;
}

export function readStoredTeacherScope(userId?: string | null): StoredTeacherScope | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(teacherScopeStorageKey(userId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<StoredTeacherScope>;
        if (!parsed || typeof parsed !== "object") return null;
        const classId = typeof parsed.classId === "string" && parsed.classId.trim() ? parsed.classId.trim() : null;
        const learnerId = isUsableChildId(parsed.learnerId ?? null) ? parsed.learnerId!.trim() : null;
        if (!classId && !learnerId) return null;
        return {
            classId,
            learnerId,
            ...(typeof parsed.name === "string" && parsed.name ? { name: parsed.name } : {}),
        };
    } catch {
        return null;
    }
}

export function writeStoredTeacherScope(scope: StoredTeacherScope | null, userId?: string | null): void {
    if (typeof window === "undefined") return;
    const key = teacherScopeStorageKey(userId);
    try {
        if (!scope || (!scope.classId && !isUsableChildId(scope.learnerId))) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, JSON.stringify({
                classId: scope.classId ?? null,
                learnerId: isUsableChildId(scope.learnerId) ? scope.learnerId : null,
                ...(scope.name ? { name: scope.name } : {}),
            }));
        }
        if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
            window.dispatchEvent(new CustomEvent("xueji:learner-scope-change"));
        }
    } catch {
        // 隐私模式或配额满时忽略
    }
}

export function isUsableChildId(value: string | null | undefined): value is string {
    return !!value && value !== SELF_STUDENT_KEY;
}

export function childIdFromSearchParams(params: URLSearchParams): string | null {
    const learnerId = params.get("learnerId");
    if (isUsableChildId(learnerId)) return learnerId;
    const studentKey = params.get("studentKey");
    if (isUsableChildId(studentKey)) return studentKey;
    return null;
}

export function readStoredChild(userId?: string | null): StoredChild | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(currentChildStorageKey(userId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredChild;
        if (!parsed || !isUsableChildId(parsed.id)) return null;
        return { id: parsed.id, name: typeof parsed.name === "string" ? parsed.name : undefined };
    } catch {
        return null;
    }
}

export function writeStoredChild(child: StoredChild | null, userId?: string | null): void {
    if (typeof window === "undefined") return;
    const key = currentChildStorageKey(userId);
    try {
        if (!child || !isUsableChildId(child.id)) {
            window.localStorage.removeItem(key);
            return;
        }
        window.localStorage.setItem(key, JSON.stringify({
            id: child.id,
            ...(child.name ? { name: child.name } : {}),
        }));
    } catch {
        // 隐私模式或配额满时忽略
    }
}

/** 给路径加上当前孩子参数：/learn 用 studentKey，其余用 learnerId */
export function withChildParam(href: string, learnerId: string | null | undefined): string {
    if (!isUsableChildId(learnerId)) return href;
    const [pathAndQuery, hash] = href.split("#");
    const [path, query] = pathAndQuery.split("?");
    const params = new URLSearchParams(query || "");
    if (path === "/learn" || path.startsWith("/learn/")) {
        params.set("studentKey", learnerId);
        params.delete("learnerId");
    } else {
        params.set("learnerId", learnerId);
    }
    const search = params.toString();
    return `${path}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
    const next = items.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}
