"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
    value: T;
    label: React.ReactNode;
    icon?: LucideIcon;
    disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
    options: SegmentedOption<T>[];
    value: T;
    onChange: (value: T) => void;
    /** 控件组的无障碍名称，帮助屏幕阅读器用户理解切换用途 */
    ariaLabel?: string;
    size?: "sm" | "md";
    className?: string;
}

/**
 * 分段切换控件：遵循 WAI-ARIA Tabs 规范，内置 Roving tabIndex 与左右/首尾方向键漫游
 */
export function SegmentedControl<T extends string>({
    options,
    value,
    onChange,
    ariaLabel,
    size = "md",
    className,
}: SegmentedControlProps<T>) {
    const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

    const moveFocusAndSelect = (targetIndex: number) => {
        const option = options[targetIndex];
        if (!option || option.disabled) return;
        buttonRefs.current[targetIndex]?.focus();
        onChange(option.value);
    };

    const findNextEnabledIndex = (currentIndex: number, step: 1 | -1): number => {
        const len = options.length;
        for (let i = 1; i <= len; i++) {
            const candidate = (currentIndex + step * i + len) % len;
            if (!options[candidate]?.disabled) return candidate;
        }
        return currentIndex;
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            moveFocusAndSelect(findNextEnabledIndex(index, 1));
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            moveFocusAndSelect(findNextEnabledIndex(index, -1));
        } else if (event.key === "Home") {
            event.preventDefault();
            const firstEnabled = options.findIndex((o) => !o.disabled);
            if (firstEnabled !== -1) moveFocusAndSelect(firstEnabled);
        } else if (event.key === "End") {
            event.preventDefault();
            for (let i = options.length - 1; i >= 0; i--) {
                if (!options[i]?.disabled) {
                    moveFocusAndSelect(i);
                    break;
                }
            }
        }
    };

    return (
        <div
            className={cn(
                "grid gap-1 rounded-xl border border-border/70 bg-muted/80 p-1",
                className
            )}
            style={{ gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0, 1fr))` }}
            role="tablist"
            aria-label={ariaLabel}
        >
            {options.map(({ value: optionValue, label, icon: Icon, disabled }, index) => {
                const active = optionValue === value;
                return (
                    <button
                        key={optionValue}
                        ref={(el) => {
                            buttonRefs.current[index] = el;
                        }}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        disabled={disabled}
                        tabIndex={active ? 0 : -1}
                        className={cn(
                            "flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45",
                            size === "sm" ? "px-2 py-1.5 text-xs" : "px-2.5 py-2.5 text-sm",
                            active
                                ? "bg-card text-primary shadow-sm ring-1 ring-border/60"
                                : "text-muted-foreground hover:bg-card/50 hover:text-foreground"
                        )}
                        onClick={() => onChange(optionValue)}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                    >
                        {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                        <span className="truncate">{label}</span>
                    </button>
                );
            })}
        </div>
    );
}
