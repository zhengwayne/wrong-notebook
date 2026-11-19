/**
 * 裁剪框擦除做题痕迹 & 从原图重新裁剪（Ported from margrop/wrong-notebook 35431618, MIT）
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    cropImageRegions: vi.fn(async () => [new Blob(['x'], { type: 'image/jpeg' })]),
}));

vi.mock('@/lib/image-crop', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/image-crop')>()),
    cropImageRegions: mocks.cropImageRegions,
}));

import { ImageCropper } from '@/components/image-cropper';
import { blobFromDataUrl } from '@/components/error-detail/crop-from-original-image-button';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { translations } from '@/lib/translations';

const zh = translations.zh.common.cropper;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.cropImageRegions.mockClear();
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

const button = (text: string) => [...document.querySelectorAll('button')].find((el) => el.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe('ImageCropper 擦除', () => {
    it('打开擦除后涂抹，确认时把笔画随裁剪区域交给裁剪', async () => {
        const onCropComplete = vi.fn();
        await act(async () => root.render(
            <LanguageProvider>
                <ImageCropper imageSrc="data:image/png;base64,iVBORw0KGgo=" open onClose={vi.fn()} onCropComplete={onCropComplete} />
            </LanguageProvider>,
        ));
        expect(button(zh.erase)).toBeDefined();
        expect(button(zh.brushThin)).toBeUndefined();

        await act(async () => button(zh.erase)!.click());
        expect(button(zh.eraseDone)).toBeDefined();
        expect(button(zh.brushThick)).toBeDefined();

        const canvas = document.querySelector('[data-testid="erase-canvas"]') as HTMLCanvasElement;
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
        Object.defineProperty(canvas, 'clientWidth', { value: 200, configurable: true });
        const pointer = (type: string, x: number, y: number) => {
            const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
            Object.defineProperty(event, 'pointerId', { value: 1 });
            canvas.dispatchEvent(event);
        };
        await act(async () => {
            pointer('pointerdown', 20, 50);
            pointer('pointermove', 100, 50);
            pointer('pointerup', 100, 50);
        });
        expect(button(zh.undoErase)).toBeDefined();

        await act(async () => button(translations.zh.common.confirm)!.click());
        expect(mocks.cropImageRegions).toHaveBeenCalledTimes(1);
        const [, regions] = mocks.cropImageRegions.mock.calls[0] as unknown as [HTMLImageElement, Array<{ erase?: Array<{ points: Array<{ x: number; y: number }>; radius: number }> }>];
        expect(regions[0].erase).toHaveLength(1);
        expect(regions[0].erase![0].points[0]).toEqual({ x: 0.1, y: 0.5 });
        expect(regions[0].erase![0].points.at(-1)).toEqual({ x: 0.5, y: 0.5 });
        // 中号画笔 7px / 显示宽 200px
        expect(regions[0].erase![0].radius).toBeCloseTo(0.035);
        expect(onCropComplete).toHaveBeenCalled();
    });

    it('撤销后不再带擦除笔画', async () => {
        await act(async () => root.render(
            <LanguageProvider>
                <ImageCropper imageSrc="data:image/png;base64,iVBORw0KGgo=" open onClose={vi.fn()} onCropComplete={vi.fn()} />
            </LanguageProvider>,
        ));
        await act(async () => button(zh.erase)!.click());
        const canvas = document.querySelector('[data-testid="erase-canvas"]') as HTMLCanvasElement;
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
        await act(async () => {
            const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 });
            canvas.dispatchEvent(down);
            canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        });
        await act(async () => button(zh.undoErase)!.click());
        await act(async () => button(translations.zh.common.confirm)!.click());
        const [, regions] = mocks.cropImageRegions.mock.calls[0] as unknown as [HTMLImageElement, Array<{ erase?: unknown }>];
        expect(regions[0].erase).toBeUndefined();
    });

    it('eraseEnabled=false 时不显示擦除按钮', async () => {
        await act(async () => root.render(
            <LanguageProvider>
                <ImageCropper imageSrc="data:image/png;base64,iVBORw0KGgo=" open onClose={vi.fn()} onCropComplete={vi.fn()} eraseEnabled={false} />
            </LanguageProvider>,
        ));
        expect(button(zh.erase)).toBeUndefined();
    });
});

describe('blobFromDataUrl', () => {
    it('把已保存的原图 data URL 还原为 Blob', async () => {
        const blob = blobFromDataUrl('data:image/png;base64,aGVsbG8=');
        expect(blob?.type).toBe('image/png');
        expect(await blob?.text()).toBe('hello');
    });

    it('非图片或非 data URL 返回 null', () => {
        expect(blobFromDataUrl('https://example.com/a.png')).toBeNull();
        expect(blobFromDataUrl('data:text/html;base64,PGI+')).toBeNull();
        expect(blobFromDataUrl(null)).toBeNull();
    });
});
