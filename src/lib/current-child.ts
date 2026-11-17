/**
 * 家长身份下当前选中的孩子。
 * URL 参数优先（learnerId，学习路径页也接受 studentKey），并写入 localStorage，方便跨页面保留选择。
 */
import { SELF_STUDENT_KEY } from "@/lib/learning-path/types";

export const CURRENT_CHILD_STORAGE_KEY = "xueji.currentChildLearner";

export interface StoredChild {
    id: string;
    name?: string;
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

export function readStoredChild(): StoredChild | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(CURRENT_CHILD_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredChild;
        if (!parsed || !isUsableChildId(parsed.id)) return null;
        return { id: parsed.id, name: typeof parsed.name === "string" ? parsed.name : undefined };
    } catch {
        return null;
    }
}

export function writeStoredChild(child: StoredChild | null): void {
    if (typeof window === "undefined") return;
    try {
        if (!child || !isUsableChildId(child.id)) {
            window.localStorage.removeItem(CURRENT_CHILD_STORAGE_KEY);
            return;
        }
        window.localStorage.setItem(CURRENT_CHILD_STORAGE_KEY, JSON.stringify({
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
