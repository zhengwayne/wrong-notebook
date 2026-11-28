// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    post: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({ apiClient: { post: mocks.post, get: vi.fn() } }));
vi.mock('@/lib/feedback', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess, warning: vi.fn(), info: vi.fn() } }));

import { filterModels, ModelSelector } from '@/components/ui/model-selector';
import { LanguageProvider } from '@/contexts/LanguageContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ModelSelector 模型列表下拉', () => {
    let container: HTMLDivElement;
    let root: Root;
    const onModelChange = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    async function render() {
        await act(async () => {
            root.render(
                <LanguageProvider>
                    <ModelSelector provider="openai" apiKey="********" baseUrl="https://a.example.com/v1" instanceId="i1" currentModel="old-model" onModelChange={onModelChange} />
                </LanguageProvider>,
            );
        });
    }

    it('刷新只传掩码，拉到后可搜索并选择；手动输入仍可用', async () => {
        mocks.post.mockResolvedValueOnce({ models: [{ id: 'qwen-vl', name: 'qwen-vl' }, { id: 'gpt-x', name: 'gpt-x' }, { id: 'qwen-max', name: 'qwen-max' }] });
        await render();
        await act(async () => {
            (container.querySelector('[data-testid="model-refresh"]') as HTMLButtonElement).click();
        });
        expect(mocks.post).toHaveBeenCalledWith('/api/ai/models', expect.objectContaining({ provider: 'openai', apiKey: '********', instanceId: 'i1' }));
        expect(mocks.toastSuccess).toHaveBeenCalled();
        const options = () => Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent);
        expect(options()).toEqual(['gpt-x', 'qwen-max', 'qwen-vl']);

        const input = container.querySelector('[data-testid="model-input"]') as HTMLInputElement;
        await act(async () => setInput(input, 'qwen'));
        expect(options()).toEqual(['qwen-max', 'qwen-vl']);

        await act(async () => {
            container.querySelectorAll('[role="option"]')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(onModelChange).toHaveBeenLastCalledWith('qwen-vl');
        expect(input.value).toBe('qwen-vl');
        expect(container.querySelector('[role="listbox"]')).toBeNull();

        await act(async () => setInput(input, 'my-custom-model'));
        expect(onModelChange).toHaveBeenLastCalledWith('my-custom-model');
    });

    it('失败时弹出错误提示，保留手动输入', async () => {
        mocks.post.mockResolvedValueOnce({ models: [], error: 'BASE_URL_CHANGED' });
        await render();
        await act(async () => {
            (container.querySelector('[data-testid="model-refresh"]') as HTMLButtonElement).click();
        });
        expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('Base URL'));
        expect((container.querySelector('[data-testid="model-input"]') as HTMLInputElement).value).toBe('old-model');

        mocks.post.mockRejectedValueOnce(new Error('network down'));
        await act(async () => {
            (container.querySelector('[data-testid="model-refresh"]') as HTMLButtonElement).click();
        });
        expect(mocks.toastError).toHaveBeenLastCalledWith(expect.stringContaining('network down'));
    });

    it('filterModels 忽略大小写', () => {
        expect(filterModels([{ id: 'GPT-X', name: 'GPT-X' }, { id: 'b', name: 'b', owned_by: 'Acme' }], 'acme').map((m) => m.id)).toEqual(['b']);
    });
});
