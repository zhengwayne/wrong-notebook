/**
 * 对话框居中不依赖 CSS translate（旧版安卓 WebView 兼容，Ported from margrop/wrong-notebook d1490587, MIT）
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

async function renderDialog(className?: string) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(
        <Dialog open>
            <DialogContent className={className} aria-describedby={undefined}>
                <DialogTitle>标题</DialogTitle>
            </DialogContent>
        </Dialog>,
    ));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    return { dialog, unmount: () => act(async () => root.unmount()) };
}

describe('DialogContent 居中', () => {
    it('用 inset-0 + m-auto 居中，不用 translate 与 left/top 50%', async () => {
        const { dialog, unmount } = await renderDialog();
        const classes = dialog.className.split(/\s+/);
        expect(classes).toEqual(expect.arrayContaining(['fixed', 'inset-0', 'm-auto', 'h-fit']));
        expect(dialog.className).not.toMatch(/translate-[xy]-|left-\[50%\]|top-\[50%\]/);
        await unmount();
    });

    it('固定高度的对话框（如裁剪框）覆盖 h-fit', async () => {
        const { dialog, unmount } = await renderDialog('h-[90vh]');
        expect(dialog.className).toContain('h-[90vh]');
        expect(dialog.className).not.toContain('h-fit');
        await unmount();
    });
});
