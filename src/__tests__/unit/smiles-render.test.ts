import { describe, expect, it } from 'vitest';
import { renderSmilesSvg } from '@/lib/smiles-render';

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
});
