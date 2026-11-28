import React, { useMemo, type ComponentProps } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { KATEX_RENDER_OPTIONS } from '@/lib/katex-options';
import { prepareMarkdownMath } from '@/lib/markdown-math';
import { remarkSafeSmiles } from '@/lib/markdown-smiles';
import { protectUnderlineTags, remarkSafeUnderline } from '@/lib/markdown-underline';
import { SmilesStructure } from '@/components/smiles-structure';
import { cn } from '@/lib/utils';

type MarkdownPluginProps = ComponentProps<typeof ReactMarkdown>;
const REMARK_PLUGINS: MarkdownPluginProps['remarkPlugins'] = [
    remarkMath,
    remarkGfm,
    remarkSafeUnderline,
    remarkSafeSmiles,
];
const REHYPE_PLUGINS: MarkdownPluginProps['rehypePlugins'] = [
    [rehypeKatex, KATEX_RENDER_OPTIONS],
];

interface MarkdownRendererProps {
    content?: string | null;
    className?: string;
    /** compact：收紧段落间距，供列表/对话框预览使用 */
    variant?: 'block' | 'compact';
    /** 按行数用 CSS line-clamp 裁切，避免把公式从中间切断 */
    clamp?: number;
}

function buildMarkdownComponents(compact: boolean): Components {
    return {
        h1: ({ node: _node, ...props }) => <h1 className={compact ? 'text-base font-bold' : 'text-2xl font-bold mt-6 mb-4'} {...props} />,
        h2: ({ node: _node, ...props }) => <h2 className={compact ? 'text-base font-bold' : 'text-xl font-bold mt-5 mb-3'} {...props} />,
        h3: ({ node: _node, ...props }) => <h3 className={compact ? 'text-sm font-bold' : 'text-lg font-bold mt-4 mb-2'} {...props} />,
        p: ({ node: _node, ...props }) => <p className={compact ? 'mb-0 leading-relaxed' : 'mb-3 leading-relaxed'} {...props} />,
        ul: ({ node: _node, ...props }) => <ul className={`list-disc list-outside pl-6 space-y-1 ${compact ? 'mb-0' : 'mb-3'}`} {...props} />,
        ol: ({ node: _node, ...props }) => <ol className={`list-decimal list-outside pl-6 space-y-1 ${compact ? 'mb-0' : 'mb-3'}`} {...props} />,
        // list-outside：编号与首行正文对齐；避免 list-inside 在 li>p 时把编号单独顶到上一行
        li: ({ node: _node, ...props }) => <li className="[&>p]:mb-1 [&>p:last-child]:mb-0 [&>ul]:mt-1 [&>ol]:mt-1" {...props} />,
        blockquote: ({ node: _node, ...props }) => (
            <blockquote className={`border-l-4 border-primary pl-4 italic text-muted-foreground ${compact ? 'my-1' : 'my-4'}`} {...props} />
        ),
        // react-markdown 10 不再传 inline：code 统一按行内样式，代码块样式由 pre 提供并重置内部 code
        code: ({ node: _node, className, ...props }) => (
            <code className={`bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-foreground ${className ?? ''}`} {...props} />
        ),
        pre: ({ node: _node, ...props }) => (
            <pre className={`bg-muted p-4 rounded-lg overflow-x-auto font-mono text-sm [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none ${compact ? 'my-1' : 'my-3'}`} {...props} />
        ),
        table: ({ node: _node, ...props }) => (
            <div className={compact ? 'overflow-x-auto' : 'overflow-x-auto my-4'}>
                <table className="min-w-full border-collapse border border-border" {...props} />
            </div>
        ),
        th: ({ node: _node, ...props }) => (
            <th className="border border-border px-4 py-2 bg-muted font-semibold text-left" {...props} />
        ),
        td: ({ node: _node, ...props }) => (
            <td className="border border-border px-4 py-2" {...props} />
        ),
        strong: ({ node: _node, ...props }) => <strong className="font-bold text-foreground" {...props} />,
        em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
        u: ({ node: _node, ...props }) => <u className="underline decoration-foreground underline-offset-2 decoration-1" {...props} />,
        // ```smiles 围栏：由 remarkSafeSmiles 转成自定义标签
        'smiles-structure': ({ node, ...props }: { node?: { properties?: { dataSmiles?: string } }; 'data-smiles'?: string; children?: React.ReactNode }) => (
            <SmilesStructure smiles={String(props['data-smiles'] ?? node?.properties?.dataSmiles ?? '')} />
        ),
    } as Components;
}

const COMPACT_COMPONENTS = buildMarkdownComponents(true);
const BLOCK_COMPONENTS = buildMarkdownComponents(false);

function MarkdownRendererInner({ content, className = '', variant = 'block', clamp }: MarkdownRendererProps) {
    // 公式片段先保护起来，只整理公式以外的文字（见 markdown-math.ts）
    const processedContent = useMemo(
        () => prepareMarkdownMath(content, protectUnderlineTags),
        [content],
    );
    const compact = variant === 'compact' || !!clamp;

    return (
        <div
            className={cn(
                'markdown-content min-w-0',
                compact
                    ? 'overflow-hidden [&_p]:mb-0 [&_p]:leading-relaxed [&_h1]:my-0 [&_h1]:text-base [&_h2]:my-0 [&_h2]:text-base [&_h3]:my-0 [&_h3]:text-sm [&_ul]:mb-0 [&_ol]:mb-0 [&_blockquote]:my-1 [&_pre]:my-1 [&_.katex-display]:my-0.5'
                    : 'overflow-x-auto',
                className,
            )}
            style={clamp ? { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: clamp, overflow: 'hidden' } : undefined}
        >
            <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={compact ? COMPACT_COMPONENTS : BLOCK_COMPONENTS}
            >
                {processedContent}
            </ReactMarkdown>
        </div>
    );
}

export const MarkdownRenderer = React.memo(MarkdownRendererInner);
MarkdownRenderer.displayName = 'MarkdownRenderer';
