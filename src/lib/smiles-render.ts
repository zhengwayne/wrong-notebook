/**
 * 把 SMILES 画成净化后的 SVG。只在浏览器（或 jsdom）里调用，
 * 并通过动态 import 加载 smiles-drawer，避免进入默认打包。
 */
import SmilesDrawer from 'smiles-drawer';
import { sanitizeFigureSvg } from '@/lib/figure-svg';

export const MAX_SMILES_LENGTH = 1000;

const DRAWER_OPTIONS = {
    width: 320,
    height: 240,
    compactDrawing: false,
};

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
        return sanitizeFigureSvg(new XMLSerializer().serializeToString(svg));
    } catch {
        return null;
    }
}
