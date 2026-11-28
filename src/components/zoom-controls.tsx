"use client";

import { ZoomIn, ZoomOut } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { MAX_ZOOM, MIN_ZOOM } from "@/lib/use-image-zoom";

interface ZoomControlsProps {
    zoom: number;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onReset: () => void;
    /** overlay 浮在图上；toolbar 放在图片外的工具栏，避免挡住标记 */
    variant?: "overlay" | "toolbar";
}

/** 缩小 / 当前比例（点击还原）/ 放大 */
export function ZoomControls({ zoom, onZoomIn, onZoomOut, onReset, variant = "overlay" }: ZoomControlsProps) {
    const { t } = useLanguage();
    const toolbar = variant === "toolbar";
    const focusClass = toolbar
        ? "outline-none focus-visible:ring-2 focus-visible:ring-[#7c6bb5]"
        : "outline-none focus-visible:ring-2 focus-visible:ring-white/70";
    const buttonClass = toolbar
        ? `flex h-9 w-9 items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent ${focusClass}`
        : `flex h-9 w-9 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent ${focusClass}`;
    const shellClass = toolbar
        ? "flex items-center gap-0.5 rounded-full border border-border bg-card p-1"
        : "flex items-center gap-0.5 rounded-full bg-black/60 p-1 shadow-lg backdrop-blur-sm";
    const percentClass = toolbar
        ? `h-9 min-w-14 rounded-full px-2 text-center text-xs font-medium tabular-nums text-foreground hover:bg-accent ${focusClass}`
        : `h-9 min-w-14 rounded-full px-2 text-center text-xs font-medium tabular-nums text-white hover:bg-white/20 ${focusClass}`;

    return (
        <div className={shellClass}>
            <button type="button" className={buttonClass} onClick={onZoomOut} disabled={zoom <= MIN_ZOOM} aria-label={t.common.cropper.zoomOut} title={t.common.cropper.zoomOut}>
                <ZoomOut className="h-4 w-4" />
            </button>
            <button
                type="button"
                className={percentClass}
                onClick={onReset}
                aria-label={t.common.cropper.resetZoom}
                title={t.common.cropper.resetZoom}
            >
                {Math.round(zoom * 100)}%
            </button>
            <button type="button" className={buttonClass} onClick={onZoomIn} disabled={zoom >= MAX_ZOOM} aria-label={t.common.cropper.zoomIn} title={t.common.cropper.zoomIn}>
                <ZoomIn className="h-4 w-4" />
            </button>
        </div>
    );
}
