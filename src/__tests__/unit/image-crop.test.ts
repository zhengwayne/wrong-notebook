import { describe, it, expect } from 'vitest';
import { applyEraseStrokes, toSafeImageSrc } from '@/lib/image-crop';

describe('toSafeImageSrc', () => {
    it('接受本地文件生成的 blob 与 data 图片地址', () => {
        expect(toSafeImageSrc('blob:http://localhost:3000/0f1e2d3c')).toBe('blob:http://localhost:3000/0f1e2d3c');
        expect(toSafeImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    });

    it('拒绝脚本、HTML 和普通网络地址', () => {
        expect(toSafeImageSrc('javascript:alert(1)')).toBeUndefined();
        expect(toSafeImageSrc('data:text/html,<script>alert(1)</script>')).toBeUndefined();
        expect(toSafeImageSrc('https://example.com/a.png')).toBeUndefined();
        expect(toSafeImageSrc('')).toBeUndefined();
    });
});

describe('applyEraseStrokes（Ported from margrop/wrong-notebook 35431618, MIT）', () => {
    function recordingContext() {
        const calls: Array<[string, ...unknown[]]> = [];
        const ctx = new Proxy({} as Record<string, unknown>, {
            get(target, prop: string) {
                if (prop in target) return target[prop];
                return (...args: unknown[]) => { calls.push([prop, ...args]); };
            },
            set(target, prop: string, value) {
                target[prop] = value;
                calls.push([`set:${prop}`, value]);
                return true;
            },
        }) as unknown as CanvasRenderingContext2D;
        return { ctx, calls };
    }

    it('没有笔画时不改动画布', () => {
        const { ctx, calls } = recordingContext();
        applyEraseStrokes(ctx, [], { width: 100, height: 100 }, { sx: 0, sy: 0, sw: 100, sh: 100 }, { width: 100, height: 100 });
        expect(calls).toEqual([]);
    });

    it('按裁剪区域平移坐标，用白色圆头笔覆盖', () => {
        const { ctx, calls } = recordingContext();
        applyEraseStrokes(ctx, [{ points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }], radius: 0.01 }],
            { width: 1000, height: 800 }, { sx: 400, sy: 300, sw: 200, sh: 200 }, { width: 200, height: 200 });
        expect(calls).toContainEqual(['set:strokeStyle', '#ffffff']);
        expect(calls).toContainEqual(['moveTo', 100, 100]);
        expect(calls).toContainEqual(['lineTo', 200, 100]);
        // 半径 0.01 × 原图宽 1000 = 10px，线宽 20
        expect(calls).toContainEqual(['set:lineWidth', 20]);
    });

    it('单点笔画画成实心圆', () => {
        const { ctx, calls } = recordingContext();
        applyEraseStrokes(ctx, [{ points: [{ x: 0.1, y: 0.2 }], radius: 0.005 }],
            { width: 100, height: 100 }, { sx: 0, sy: 0, sw: 100, sh: 100 }, { width: 100, height: 100 });
        expect(calls.find(([name]) => name === 'arc')?.slice(1, 4)).toEqual([10, 20, 0.5]);
        expect(calls.some(([name]) => name === 'fill')).toBe(true);
    });
});
