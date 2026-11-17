"use client";

import { QuestionFigure } from "@/components/question-figure";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

interface FigureCompareProps {
    svg: string;
    originalSrc: string;
    onEnlarge?: (src: string) => void;
    /** 打印时限制原图宽度，与打印预览的图片比例一致 */
    imageScale?: number;
    className?: string;
}

/**
 * 把 AI 重绘的 SVG 配图和拍照原图放在一起对照：
 * 宽屏并排，窄屏上下堆叠；打印时并排。无渐变，沿用卡片边框。
 */
export function FigureCompare({ svg, originalSrc, onEnlarge, imageScale, className }: FigureCompareProps) {
    const { t } = useLanguage();

    return (
        <div
            data-testid="figure-compare"
            className={cn("my-3 grid grid-cols-1 gap-3 sm:grid-cols-2 print:grid-cols-2", className)}
        >
            <figure className="rounded-2xl border border-border bg-card p-3">
                <figcaption className="mb-2 text-xs text-muted-foreground">{t.figure.redrawnLabel}</figcaption>
                <QuestionFigure svg={svg} className="my-0" />
            </figure>
            <figure className="rounded-2xl border border-border bg-card p-3">
                <figcaption className="mb-2 text-xs text-muted-foreground">{t.figure.originalLabel}</figcaption>
                <img
                    src={originalSrc}
                    alt={t.detail?.originalProblem || "Original Problem"}
                    className={cn("mx-auto block h-auto max-w-full rounded-lg border", onEnlarge && "cursor-pointer")}
                    style={{ maxHeight: 360, maxWidth: imageScale != null ? `${imageScale}%` : undefined }}
                    onClick={onEnlarge ? () => onEnlarge(originalSrc) : undefined}
                />
                {onEnlarge && (
                    <p className="mt-1 text-center text-xs text-muted-foreground">{t.detail?.clickToEnlarge || "Click to enlarge"}</p>
                )}
            </figure>
        </div>
    );
}
