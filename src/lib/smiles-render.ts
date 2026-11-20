/**
 * 把 SMILES 画成净化后的 SVG。只在浏览器（或 jsdom）里调用，
 * 并通过动态 import 加载 smiles-drawer，避免进入默认打包。
 */
import SmilesDrawer from 'smiles-drawer';
import { sanitizeFigureSvg } from '@/lib/figure-svg';

export const MAX_SMILES_LENGTH = 1000;

/** 画完后给 viewBox 四周再留白，避免端基 HO 等标签贴边被裁切 */
export const SMILES_VIEWBOX_MARGIN = 16;

/** SVG 长边上限（像素）。小分子按 1 用户单位 = 1px 显示，避免被放大到默认 300px */
export const SMILES_MAX_SIZE_PX = 240;

const DRAWER_OPTIONS = {
    width: 320,
    height: 240,
    compactDrawing: false,
    padding: 20,
};

function parseViewBox(svg: SVGSVGElement): { x: number; y: number; w: number; h: number } | null {
    const raw = svg.getAttribute('viewBox');
    if (!raw) return null;
    const parts = raw.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * 扩大 viewBox 以免标签贴边被裁切，并写上按比例且有上限的宽高，
 * 避免没有固有尺寸的 SVG 在 <img> 里被撑到浏览器默认的 300px。
 */
export function fitSmilesSvgViewport(svg: SVGSVGElement): void {
    const box = parseViewBox(svg);
    if (!box) return;
    const x = box.x - SMILES_VIEWBOX_MARGIN;
    const y = box.y - SMILES_VIEWBOX_MARGIN;
    const w = box.w + SMILES_VIEWBOX_MARGIN * 2;
    const h = box.h + SMILES_VIEWBOX_MARGIN * 2;
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    const scale = Math.min(1, SMILES_MAX_SIZE_PX / Math.max(w, h, 1));
    svg.setAttribute('width', String(Math.round(w * scale)));
    svg.setAttribute('height', String(Math.round(h * scale)));
}

/** 解析成功返回净化后的 SVG 字符串，失败或过长返回 null */
export function renderSmilesSvg(smiles: string): string | null {
    if (typeof document === 'undefined') return null;
    const trimmed = smiles.trim();
    if (!trimmed || trimmed.length > MAX_SMILES_LENGTH) return null;

    let graph: unknown;
    let failed = false;
    SmilesDrawer.parse(
        trimmed,
        (parsed) => {
            graph = parsed;
        },
        () => {
            failed = true;
        },
    );
    if (failed || !graph) return null;

    try {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        const drawer = new SmilesDrawer.SvgDrawer(DRAWER_OPTIONS);
        drawer.draw(graph, svg, 'light');
        fitSmilesSvgViewport(svg);
        return sanitizeFigureSvg(new XMLSerializer().serializeToString(svg));
    } catch {
        return null;
    }
}
