"use client";

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { figureSvgToDataUri } from '@/lib/figure-svg';

interface SmilesStructureProps {
    smiles: string;
    className?: string;
}

function Fallback({ smiles, className }: { smiles: string; className?: string }) {
    return (
        <figure
            data-testid="smiles-structure"
            data-smiles={smiles}
            data-fallback=""
            className={cn('my-3 rounded-2xl border border-border bg-card p-3', className)}
        >
            <pre className="overflow-x-auto font-mono text-sm text-foreground whitespace-pre-wrap break-all">{smiles}</pre>
        </figure>
    );
}

/**
 * 客户端惰性加载 smiles-drawer，把 SMILES 画成 SVG；
 * 服务端、解析失败或尚未画完时显示 SMILES 原文。
 */
export function SmilesStructure({ smiles, className }: SmilesStructureProps) {
    const trimmed = smiles.trim();
    const [drawn, setDrawn] = useState<{ smiles: string; svg: string | null } | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (!trimmed) return;
        void import('@/lib/smiles-render')
            .then(({ renderSmilesSvg }) => renderSmilesSvg(trimmed))
            .then((result) => {
                if (!cancelled) setDrawn({ smiles: trimmed, svg: result });
            })
            .catch(() => {
                if (!cancelled) setDrawn({ smiles: trimmed, svg: null });
            });
        return () => {
            cancelled = true;
        };
    }, [trimmed]);

    const svg = drawn?.smiles === trimmed ? drawn.svg : null;
    if (svg) {
        return (
            <figure data-testid="smiles-structure" data-smiles={trimmed} className={cn('my-3', className)}>
                <img
                    src={figureSvgToDataUri(svg)}
                    alt={trimmed}
                    className="mx-auto block h-auto max-w-full rounded border bg-white p-2"
                    style={{ maxHeight: 280 }}
                />
            </figure>
        );
    }

    return <Fallback smiles={trimmed} className={className} />;
}
