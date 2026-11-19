/**
 * 批量导入面板：一图多题部分保存失败后，点重试只补存未成功的题，不重新识别、不产生重复题
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BatchImportPanel } from '@/components/batch-import-panel';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { zh } from '@/lib/translations/zh';

const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api-client')>();
    return { ApiError: actual.ApiError, apiClient: api };
});
vi.mock('@/lib/image-utils', () => ({ processImageFile: vi.fn(async () => 'data:image/png;base64,dGVzdA==') }));
vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

const flush = async () => {
    for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
};

it('部分保存失败显示已保存进度与链接，重试只补存失败的题', async () => {
    const base = { questionText: '题一', answerText: '', analysis: '', knowledgePoints: [], subject: '数学', requiresImage: false };
    const savedPosts: string[] = [];
    let failSecond = true;
    api.post.mockImplementation(async (url: string, body: { questionText?: string }) => {
        if (url === '/api/analyze') return { ...base, items: [base, { ...base, questionText: '题二' }] };
        savedPosts.push(body.questionText ?? '');
        if (body.questionText === '题二' && failSecond) {
            failSecond = false;
            throw new Error('save failed');
        }
        return { id: body.questionText === '题一' ? 'e1' : 'e2', shortId: body.questionText === '题一' ? 'E01' : 'E02', subject: { id: 'nb', name: '数学本' } };
    });

    await act(async () => root.render(
        <LanguageProvider>
            <BatchImportPanel blobs={[new Blob(['x'], { type: 'image/png' })]} onClose={vi.fn()} />
        </LanguageProvider>,
    ));
    await flush();

    expect(container.textContent).toContain(zh.batchImport.partialSaved.replace('{saved}', '1').replace('{total}', '2'));
    expect(container.textContent).toContain('数学本 · E01');
    const retry = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(zh.batchImport.retry));
    await act(async () => retry!.click());
    await flush();

    expect(api.post.mock.calls.filter(([url]) => url === '/api/analyze')).toHaveLength(1);
    expect(savedPosts).toEqual(['题一', '题二', '题二']);
    expect(container.textContent).toContain('数学本 · E02');
    expect(container.textContent).toContain(zh.batchImport.status.success);
});
