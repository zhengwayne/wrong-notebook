/**
 * 多选栏「移动到错题本」（Ported from margrop/wrong-notebook 1c3f25cf, MIT）
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(async () => []), post: vi.fn() } }));

import { ErrorListSelectionBar } from '@/components/error-list-selection-bar';
import { MoveToNotebookDialog } from '@/components/move-to-notebook-dialog';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { translations } from '@/lib/translations';

const zh = translations.zh.notebook;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

const button = (text: string) => [...document.querySelectorAll('button')].find((el) => el.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe('批量移动', () => {
    it('提供 onMove 时显示「移动到错题本」，未选中时不可用', async () => {
        const onMove = vi.fn();
        await act(async () => root.render(<LanguageProvider><ErrorListSelectionBar selectedIds={['a', 'b']} deleting={false} onCancel={vi.fn()} onDelete={vi.fn()} onMove={onMove} /></LanguageProvider>));
        await act(async () => button(zh.moveSelected)!.click());
        expect(onMove).toHaveBeenCalledTimes(1);

        await act(async () => root.render(<LanguageProvider><ErrorListSelectionBar selectedIds={[]} deleting={false} onCancel={vi.fn()} onDelete={vi.fn()} onMove={onMove} /></LanguageProvider>));
        expect(button(zh.moveSelected)!.disabled).toBe(true);

        await act(async () => root.render(<LanguageProvider><ErrorListSelectionBar selectedIds={['a']} deleting={false} onCancel={vi.fn()} onDelete={vi.fn()} /></LanguageProvider>));
        expect(button(zh.moveSelected)).toBeUndefined();
    });

    it('移动对话框显示数量，未选目标错题本时不能确认', async () => {
        await act(async () => root.render(<LanguageProvider><MoveToNotebookDialog open onOpenChange={vi.fn()} count={3} moving={false} onMove={vi.fn()} /></LanguageProvider>));
        expect(document.body.textContent).toContain(zh.moveTitle.replace('{count}', '3'));
        expect(button(zh.moveConfirm)!.disabled).toBe(true);
    });
});
