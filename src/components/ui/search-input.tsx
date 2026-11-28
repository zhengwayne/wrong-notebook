"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

export interface SearchInputProps
    extends Omit<React.ComponentProps<"input">, "onChange" | "value"> {
    value: string;
    onValueChange: (value: string) => void;
    /** 清除按钮的无障碍标签 */
    clearLabel?: string;
    containerClassName?: string;
}

/**
 * 无障碍搜索输入框：内置前置图标、Escape 键快速清空与高可访问性清除按钮
 */
export function SearchInput({
    value,
    onValueChange,
    clearLabel,
    containerClassName,
    className,
    placeholder,
    onKeyDown,
    "aria-label": ariaLabel,
    ...props
}: SearchInputProps) {
    const { t } = useLanguage();
    const inputRef = React.useRef<HTMLInputElement>(null);
    const resolvedClearLabel = clearLabel ?? t.common.clearSearch;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape" && value) {
            e.preventDefault();
            onValueChange("");
            return;
        }
        onKeyDown?.(e);
    };

    const handleClear = () => {
        onValueChange("");
        inputRef.current?.focus();
    };

    return (
        <div className={cn("relative w-full", containerClassName)}>
            <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
                ref={inputRef}
                type="search"
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel ?? (typeof placeholder === "string" ? placeholder : undefined)}
                onChange={(e) => onValueChange(e.target.value)}
                onKeyDown={handleKeyDown}
                className={cn(
                    "h-10 rounded-xl bg-card pl-9 pr-9 shadow-2xs [&::-webkit-search-cancel-button]:hidden",
                    className
                )}
                {...props}
            />
            {value && (
                <button
                    type="button"
                    aria-label={resolvedClearLabel}
                    onClick={handleClear}
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

