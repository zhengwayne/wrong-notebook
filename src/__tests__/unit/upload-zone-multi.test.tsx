/**
 * 一次选择多张图片（Ported from margrop/wrong-notebook 4435a761, MIT）
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toastWarning: vi.fn() }));
vi.mock('@/lib/feedback', () => ({ toast: { warning: mocks.toastWarning, error: vi.fn(), success: vi.fn() } }));

import { MAX_IMAGE_SELECTION, UploadZone } from '@/components/upload-zone';
import { LanguageProvider } from '@/contexts/LanguageContext';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.toastWarning.mockClear();
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

const png = (name: string) => new File(['x'], `${name}.png`, { type: 'image/png' });

async function choose(files: File[]) {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
}

describe('UploadZone 多选', () => {
    it('提供 onImagesSelect 时文件框允许多选，并提示最多 4 张', async () => {
        await act(async () => root.render(<LanguageProvider><UploadZone onImageSelect={vi.fn()} onImagesSelect={vi.fn()} isAnalyzing={false} /></LanguageProvider>));
        expect((container.querySelector('input[type="file"]') as HTMLInputElement).multiple).toBe(true);
        expect(container.textContent).toContain(`最多 ${MAX_IMAGE_SELECTION} 张`);
    });

    it('选多张时交给 onImagesSelect，超过 4 张只取前 4 张并提示', async () => {
        const onImageSelect = vi.fn();
        const onImagesSelect = vi.fn();
        await act(async () => root.render(<LanguageProvider><UploadZone onImageSelect={onImageSelect} onImagesSelect={onImagesSelect} isAnalyzing={false} /></LanguageProvider>));
        await choose(['a', 'b', 'c', 'd', 'e'].map(png));
        expect(onImagesSelect).toHaveBeenCalledTimes(1);
        expect(onImagesSelect.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png']);
        expect(mocks.toastWarning).toHaveBeenCalled();
        expect(onImageSelect).not.toHaveBeenCalled();
    });

    it('只选一张时仍走单张流程；未提供 onImagesSelect 时不允许多选', async () => {
        const onImageSelect = vi.fn();
        const onImagesSelect = vi.fn();
        await act(async () => root.render(<LanguageProvider><UploadZone onImageSelect={onImageSelect} onImagesSelect={onImagesSelect} isAnalyzing={false} /></LanguageProvider>));
        await choose([png('one')]);
        expect(onImageSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'one.png' }));
        expect(onImagesSelect).not.toHaveBeenCalled();

        await act(async () => root.render(<LanguageProvider><UploadZone onImageSelect={onImageSelect} isAnalyzing={false} /></LanguageProvider>));
        expect((container.querySelector('input[type="file"]') as HTMLInputElement).multiple).toBe(false);
    });
});
