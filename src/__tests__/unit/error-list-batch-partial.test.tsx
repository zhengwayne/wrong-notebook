/**
 * 错题列表分批删除/移动：中途某批失败时也要刷新列表与顶部计数，并提示部分成功的数量
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorList } from '@/components/error-list';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { zh } from '@/lib/translations/zh';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api-client')>();
    return { ApiError: actual.ApiError, apiClient: api };
});
// 每批 1 条，便于用 3 道题模拟「第 2 批失败」
vi.mock('@/lib/chunked-batch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/chunked-batch')>();
    return { ...actual, runInChunks: (ids: string[], run: (batch: string[]) => Promise<unknown>) => actual.runInChunks(ids, run, 1) };
});
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    usePathname: () => '/notebooks/nb-1',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ id: 'nb-1' }),
}));
vi.mock('@/lib/use-current-child', () => ({
    useCurrentChild: () => ({ isTeacher: false, isParent: false, classId: null, learnerId: null, hrefWithChild: (href: string) => href }),
}));
vi.mock('@/components/short-id-locator', () => ({ ShortIdLocator: () => null }));
vi.mock('@/lib/feedback', () => ({ confirmDialog: async () => true, toast: toastMock }));
vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/question-similarity-dialog', () => ({ QuestionSimilarityDialog: () => null }));
vi.mock('@/components/error-list/error-item-card', () => ({
    ErrorItemCard: ({ item, onToggleSelect }: { item: { id: string }; onToggleSelect: () => void }) =>
        <button data-item={item.id} onClick={onToggleSelect}>{item.id}</button>,
}));
vi.mock('@/components/move-to-notebook-dialog', () => ({
    MoveToNotebookDialog: ({ open, onMove }: { open: boolean; onMove: (target: string) => void }) =>
        open ? <button data-testid="confirm-move" onClick={() => onMove('nb-2')}>confirm</button> : null,
}));
vi.mock('@/components/ui/select', () => ({
    Select: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
    SelectTrigger: () => null,
    SelectValue: () => null,
}));

let root: Root;
let container: HTMLDivElement;
const ids = ['e1', 'e2', 'e3'];

beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/error-items/list?')) {
            return { items: ids.map((id) => ({ id, questionText: id, knowledgePoints: [], tags: [] })), total: ids.length, totalPages: 1 };
        }
        if (url.startsWith('/api/tags')) return { tags: [] };
        return {};
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

const button = (text: string) => [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(text)) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => {
    if (!(el instanceof HTMLButtonElement)) throw new Error('找不到目标按钮');
    await act(async () => el.click());
};
const listCalls = () => api.get.mock.calls.filter(([url]) => String(url).startsWith('/api/error-items/list?')).length;

async function renderAndSelectAll(onItemsChanged: () => void) {
    await act(async () => root.render(<LanguageProvider><ErrorList subjectId="nb-1" onItemsChanged={onItemsChanged} /></LanguageProvider>));
    await click(button(zh.notebook.selectMode));
    for (const id of ids) await click(container.querySelector(`[data-item="${id}"]`));
}

it('分批删除中途失败：提示部分成功，仍刷新列表并通知父页面更新计数，只保留未处理的题', async () => {
    const onItemsChanged = vi.fn();
    await renderAndSelectAll(onItemsChanged);
    const before = listCalls();
    api.post.mockResolvedValueOnce({ deleted: 1, failed: [] }).mockRejectedValueOnce(new Error('network'));

    await click(button(zh.notebook.deleteSelected));

    expect(api.post).toHaveBeenCalledTimes(2);
    expect(toastMock.warning).toHaveBeenCalledWith(zh.notebook.batchDeletePartial.replace('{done}', '1').replace('{total}', '3'));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(listCalls()).toBeGreaterThan(before);
    expect(onItemsChanged).toHaveBeenCalledTimes(1);
    // 选择模式保留，未处理的 2 道题仍被选中，可直接重试
    expect(container.textContent).toContain(zh.notebook.selectedCount.replace('{count}', '2'));
});

it('分批删除第一批就失败：提示失败，仍刷新列表但不通知计数变化', async () => {
    const onItemsChanged = vi.fn();
    await renderAndSelectAll(onItemsChanged);
    const before = listCalls();
    api.post.mockRejectedValueOnce(new Error('network'));

    await click(button(zh.notebook.deleteSelected));

    expect(toastMock.error).toHaveBeenCalled();
    expect(listCalls()).toBeGreaterThan(before);
    expect(onItemsChanged).not.toHaveBeenCalled();
});

it('分批移动中途失败：提示部分成功并刷新列表与计数', async () => {
    const onItemsChanged = vi.fn();
    await renderAndSelectAll(onItemsChanged);
    await click(button(zh.notebook.moveSelected));
    const before = listCalls();
    api.post
        .mockResolvedValueOnce({ moved: 1, skipped: 0 })
        .mockResolvedValueOnce({ moved: 1, skipped: 0 })
        .mockRejectedValueOnce(new Error('network'));

    await click(container.querySelector('[data-testid="confirm-move"]'));

    expect(api.post).toHaveBeenCalledTimes(3);
    expect(toastMock.warning).toHaveBeenCalledWith(zh.notebook.movePartial.replace('{done}', '2').replace('{total}', '3'));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(listCalls()).toBeGreaterThan(before);
    expect(onItemsChanged).toHaveBeenCalledTimes(1);
});

it('分批移动全部成功：提示成功并刷新计数', async () => {
    const onItemsChanged = vi.fn();
    await renderAndSelectAll(onItemsChanged);
    await click(button(zh.notebook.moveSelected));
    api.post.mockResolvedValue({ moved: 1, skipped: 0 });

    await click(container.querySelector('[data-testid="confirm-move"]'));

    expect(toastMock.success).toHaveBeenCalledWith(zh.notebook.moveSuccess.replace('{count}', '3'));
    expect(onItemsChanged).toHaveBeenCalledTimes(1);
});
