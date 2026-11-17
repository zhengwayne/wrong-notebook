"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
    childIdFromSearchParams,
    isUsableChildId,
    readStoredChild,
    withChildParam,
    writeStoredChild,
    type StoredChild,
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
 * 家长身份下记住当前孩子，并给链接带上 learnerId / studentKey。
 * 按 userId 隔离 localStorage，避免同浏览器切换账号串孩子；只在明确读取路径后同步。
 */
export function useCurrentChild() {
    const { data: session } = useSession();
    const pathname = usePathname();
    const userId = session?.user?.id ?? null;
    const isParent = session?.user?.activePersona === "parent";
    const [child, setChild] = useState<StoredChild | null>(() => readInitialChild(userId));

    useEffect(() => {
        const fromUrl = childFromWindow();
        const fromStore = readStoredChild(userId);
        if (fromUrl) {
            const merged: StoredChild = {
                id: fromUrl.id,
                name: fromStore?.id === fromUrl.id ? fromStore.name : undefined,
            };
            writeStoredChild(merged, userId);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- 路径或账号变化时与 URL、按账号隔离的本地存储对齐当前孩子
            setChild(merged);
            return;
        }
        setChild(fromStore);
    }, [pathname, userId]);

    const setLearner = useCallback((next: StoredChild | string | null, name?: string) => {
        const stored: StoredChild | null = typeof next === "string"
            ? (isUsableChildId(next) ? { id: next, name } : null)
            : next;
        writeStoredChild(stored, userId);
        setChild(stored);
    }, [userId]);

    const learnerId = isParent && child ? child.id : null;

    const hrefWithChild = useCallback((href: string) => withChildParam(href, learnerId), [learnerId]);

    return {
        isParent,
        learnerId,
        childName: isParent ? child?.name : undefined,
        setLearner,
        hrefWithChild,
    };
}
