import { useEffect, useState } from "react";

/**
 * 对高频变化的输入值做防抖；当值为空字符串时立即同步，保证「一键清空搜索」零延迟生效
 */
export function useDebouncedValue<T>(value: T, delayMs = 220): T {
    const [debounced, setDebounced] = useState<T>(value);

    useEffect(() => {
        if (value === "") {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- 清空输入时立即归零，无需等待定时器
            setDebounced(value);
            return;
        }
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [value, delayMs]);

    return debounced;
}

