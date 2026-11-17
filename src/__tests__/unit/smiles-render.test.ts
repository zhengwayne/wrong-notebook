import { describe, expect, it } from 'vitest';
import {
    SMILES_MAX_SIZE_PX,
    renderSmilesSvg,
} from '@/lib/smiles-render';

function viewBox(svg: string): { x: number; y: number; w: number; h: number } {
    const raw = svg.match(/viewBox="([^"]+)"/)?.[1];
    expect(raw).toBeTruthy();
    const [x, y, w, h] = raw!.trim().split(/[\s,]+/).map(Number);
    return { x, y, w, h };
}

function size(svg: string): { width: number; height: number } {
    const opening = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
    const width = Number(opening.match(/\bwidth="([^"]+)"/)?.[1]);
    const height = Number(opening.match(/\bheight="([^"]+)"/)?.[1]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    return { width, height };
}

/** 11pt 大约 14.7px，两个大写字母再留一点余量，端基 HO 至少需要这么多空间 */
const MIN_LEFT_LABEL_ROOM = 28;

function leftAnchoredTextX(svg: string): number[] {
    const xs: number[] = [];
    for (const match of svg.matchAll(/<g style="transform: translateX\(([-0-9.]+)px\)[^"]*"[^>]*>[\s\S]*?<\/g>/g)) {
        if (match[0].includes('text-anchor="end"') || match[0].includes('data-direction="left"')) {
            xs.push(Number(match[1]));
        }
    }
    return xs;
}

describe('renderSmilesSvg', () => {
    it('把合法 SMILES 画成净化后的 SVG', () => {
        const svg = renderSmilesSvg('CCO');
        expect(svg).toEqual(expect.stringContaining('<svg'));
        expect(svg).toMatch(/<(line|polyline|polygon|rect|circle|ellipse|path|text)\b/i);
        expect(svg).not.toMatch(/<script/i);
    });

    it('无法解析或过长时返回 null', () => {
        expect(renderSmilesSvg('%%%not-a-molecule')).toBeNull();
        expect(renderSmilesSvg('')).toBeNull();
        expect(renderSmilesSvg('C'.repeat(1001))).toBeNull();
    });

    it('给端基 HO 标签留出边距，避免贴边裁切，并限制小分子的显示尺寸', () => {
        const ethanol = renderSmilesSvg('CCO');
        const aspirin = renderSmilesSvg('CC(=O)Oc1ccccc1C(=O)O');
        expect(ethanol).toBeTruthy();
        expect(aspirin).toBeTruthy();

        for (const svg of [ethanol!, aspirin!]) {
            const box = viewBox(svg);
            const leftXs = leftAnchoredTextX(svg);
            expect(leftXs.length).toBeGreaterThan(0);
            for (const x of leftXs) {
                expect(x - box.x).toBeGreaterThanOrEqual(MIN_LEFT_LABEL_ROOM);
            }

            const { width, height } = size(svg);
            expect(Math.max(width, height)).toBeLessThanOrEqual(SMILES_MAX_SIZE_PX);
        }

        const ethanolSize = size(ethanol!);
        const aspirinSize = size(aspirin!);
        expect(Math.max(ethanolSize.width, ethanolSize.height))
            .toBeLessThan(Math.max(aspirinSize.width, aspirinSize.height));
        // 乙醇不应被撑到接近浏览器默认的 300px
        expect(Math.max(ethanolSize.width, ethanolSize.height)).toBeLessThan(160);
    });
});

