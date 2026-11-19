"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 打印与导出时「是否带答案」的本机偏好。
 * 默认不带答案（给孩子/学生直接做题），勾选结果只记在本机浏览器，下次打印沿用。
 * 参考 margrop/wrong-notebook 7bf195e9（MIT）。
 */
export const EXAM_PRINT_INCLUDE_ANSWERS_KEY = "exam-print-include-answers";
export const PRINT_PREVIEW_SHOW_ANSWERS_KEY = "print-preview-show-answers";
export const PRINT_PREVIEW_SHOW_ANALYSIS_KEY = "print-preview-show-analysis";
export const HANDOUT_INCLUDE_ANSWERS_KEY = "grading-handout-include-answers";

/** 读取本机保存的开关；未保存或无法读取（无痕模式等）时返回 fallback */
export function readStoredFlag(key: string, fallback = false): boolean {
    try {
        const saved = window.localStorage.getItem(key);
        if (saved === "1") return true;
        if (saved === "0") return false;
    } catch {
        // 本地存储不可用时使用默认值
    }
    return fallback;
}

export function writeStoredFlag(key: string, value: boolean): void {
    try {
        window.localStorage.setItem(key, value ? "1" : "0");
    } catch {
        // 无痕模式等无法写入时只在本次生效
    }
}

/**
 * 记在本机浏览器的布尔开关。首次渲染使用 fallback（与服务端渲染一致），挂载后再读本机记录。
 */
export function useStoredFlag(key: string, fallback = false): [boolean, (next: boolean) => void] {
    const [value, setValue] = useState(fallback);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 本地存储只能在客户端挂载后读取，避免与服务端渲染结果不一致
        setValue(readStoredFlag(key, fallback));
    }, [key, fallback]);

    const update = useCallback((next: boolean) => {
        setValue(next);
        writeStoredFlag(key, next);
    }, [key]);

    return [value, update];
}
