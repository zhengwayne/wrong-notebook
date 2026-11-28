/**
 * AI 配图重复属性修复（Ported from margrop/wrong-notebook 5ff2a675, MIT）
 */
import { describe, expect, it } from 'vitest';
import { FIGURE_SVG_RULES } from '@/lib/ai/prompts';
import { figureSvgToDataUri, repairDuplicateSvgAttributes, sanitizeFigureSvg } from '@/lib/figure-svg';

const triangle = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="10,90 50,10 90,90" fill="none" stroke="#000"/></svg>';
const isValidXml = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml').getElementsByTagName('parsererror').length === 0;

describe('repairDuplicateSvgAttributes', () => {
    it('把重复写了 x2/y2 的 <line> 改成折线，箭头与描边属性保留', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 350"><g fill="none" stroke="#000">'
            + '<line x1="95" y1="95" x2="95" y2="60" x2="270" y2="60"/>'
            + '<line x1="430" y1="176" x2="430" y2="202" x2="225" y2="202" marker-end="url(#arrowhead)"/>'
            + '<line x1="0" y1="0" x2="10" y2="10"/></g></svg>';
        expect(isValidXml(svg)).toBe(false);

        const repaired = repairDuplicateSvgAttributes(svg);
        expect(isValidXml(repaired)).toBe(true);
        expect(repaired).toContain('<polyline points="95,95 95,60 270,60" fill="none"/>');
        expect(repaired).toContain('<polyline points="430,176 430,202 225,202" fill="none" marker-end="url(#arrowhead)"/>');
        expect(repaired).toContain('<line x1="0" y1="0" x2="10" y2="10"/>');
    });

    it('其他元素的重复属性只保留第一个，正常 SVG 原样返回', () => {
        expect(repairDuplicateSvgAttributes('<rect x="1" width="5" x="2" height="5">')).toBe('<rect x="1" width="5" height="5">');
        expect(repairDuplicateSvgAttributes(triangle)).toBe(triangle);
    });

    it('净化与显示时都会修复，已保存的旧配图也能显示', () => {
        const broken = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><line x1="0" y1="0" x2="5" y2="0" x2="5" y2="5" stroke="#000"/></svg>';
        expect(sanitizeFigureSvg(broken)).toContain('<polyline points="0,0 5,0 5,5" fill="none" stroke="#000"/>');
        expect(decodeURIComponent(figureSvgToDataUri(broken))).toContain('<polyline points="0,0 5,0 5,5"');
    });

    it('修复后仍不允许事件属性，并阻断通过单引号重复坐标绕过注入 onload 或外部 href', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" x="2" onload="alert(1)" width="3" height="3"/></svg>';
        expect(sanitizeFigureSvg(svg)).not.toMatch(/onload/i);

        const xssPayload = `<svg xmlns="http://www.w3.org/2000/svg"><line x1='0' y1='0' x2='1' y2='1"' x2='onload="alert(1)//' y2='2" data-x="'/></svg>`;
        const sanitizedXss = sanitizeFigureSvg(xssPayload);
        expect(sanitizedXss).not.toBeNull();
        expect(sanitizedXss).not.toMatch(/\sonload\s*=/i);
        expect(sanitizedXss).not.toContain('<polyline');

        const hrefPayload = `<svg xmlns="http://www.w3.org/2000/svg"><line x1='0' y1='0' x2='1' y2='1"' x2='href="https://evil.com/' y2='2"'/></svg>`;
        const sanitizedHref = sanitizeFigureSvg(hrefPayload);
        expect(sanitizedHref).not.toBeNull();
        expect(sanitizedHref).not.toMatch(/\shref\s*=/i);
        expect(sanitizedHref).not.toContain('<polyline');
    });

    it('非自闭合 <line>...</line> 只去重属性而不改写标签名，保持合法 XML', () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="5" y2="0" x2="5" y2="5" stroke="#000"></line></svg>';
        const repaired = repairDuplicateSvgAttributes(svg);
        expect(isValidXml(repaired)).toBe(true);
        expect(repaired).toBe('<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="5" y2="0" stroke="#000"></line></svg>');
    });

    it('配图提示词要求合法 XML、折线用 polyline', () => {
        expect(FIGURE_SVG_RULES).toContain('同一元素的属性不能重复');
        expect(FIGURE_SVG_RULES).toContain('<polyline points=');
    });
});
