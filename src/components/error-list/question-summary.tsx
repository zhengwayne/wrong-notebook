"use client";

import { MarkdownRenderer } from "@/components/markdown-renderer";

interface QuestionSummaryProps {
    text: string | null | undefined;
    /** @deprecated 改用 CSS line-clamp，保留参数以免旧调用处报错 */
    maxLength?: number;
    clamp?: number;
    className?: string;
}

/** 错题卡片的题干摘要：与详情页同一套 Markdown + KaTeX 渲染，用 CSS 限制行数 */
export function QuestionSummary({ text, clamp = 3, className = "" }: QuestionSummaryProps) {
    return (
        <MarkdownRenderer
            content={text}
            variant="compact"
            clamp={clamp}
            className={`[&_.katex]:text-[1.05em] ${className}`}
        />
    );
}
