import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NotebooksPage from '@/app/notebooks/page';
import NotebookDetailPage from '@/app/notebooks/[id]/page';
import PrintPreviewPage from '@/app/print-preview/page';
import { ErrorList } from '@/components/error-list';
import { TeacherScopeBar } from '@/components/notebooks/teacher-scope-bar';
import { ApiError } from '@/lib/api-client';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { PRINT_PREVIEW_PAGE_SIZE } from '@/lib/constants/pagination';
import { zh } from '@/lib/translations/zh';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const teacherScope = vi.hoisted(() => ({
    classId: 'class-a' as string | null,
    learnerId: null as string | null,
    isTeacher: true,
    isParent: false,
    search: 'subjectId=english-notebook&classId=class-a',
    pathname: '/notebooks',
    renderRealScopeBar: false,
    setTeacherScope: vi.fn(),
    setLearner: vi.fn(),
    hrefWithChild: (href: string) => href,
}));
vi.mock('@/lib/api-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api-client')>();
    return { ApiError: actual.ApiError, apiClient: api };
});
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: 'english-notebook' }),
    useRouter: () => router,
    usePathname: () => teacherScope.pathname,
    useSearchParams: () => new URLSearchParams(teacherScope.search),
}));
vi.mock('@/lib/use-current-child', () => ({ useCurrentChild: () => teacherScope }));
vi.mock('@/components/notebooks/teacher-scope-bar', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/notebooks/teacher-scope-bar')>();
    return {
        TeacherScopeBar: (props: Record<string, unknown>) => (
            teacherScope.renderRealScopeBar ? <actual.TeacherScopeBar {...props} /> : null
        ),
    };
});
vi.mock('@/components/short-id-locator', () => ({ ShortIdLocator: () => null }));
vi.mock('@/lib/feedback', () => ({ confirmDialog: async () => true, toast: toastMock }));
vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn() } }));
vi.mock('@/components/ui/back-button', () => ({ BackButton: () => null }));
vi.mock('@/components/question-similarity-dialog', () => ({ QuestionSimilarityDialog: () => null }));
vi.mock('@/components/error-list/error-item-card', () => ({
    ErrorItemCard: ({ item, onToggleSelect }: { item: { id: string }; onToggleSelect: () => void }) =>
        <button data-item={item.id} onClick={onToggleSelect}>{item.id}</button>,
}));
// jsdom 中用原生下拉框驱动父子组件真实的选择、清除事件和查询参数。
vi.mock('@/components/ui/select', () => ({
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) =>
        <select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
    SelectTrigger: () => null,
    SelectValue: () => null,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    vi.clearAllMocks();
    teacherScope.classId = 'class-a';
    teacherScope.learnerId = null;
    teacherScope.isTeacher = true;
    teacherScope.isParent = false;
    teacherScope.search = 'subjectId=english-notebook&classId=class-a';
    teacherScope.pathname = '/notebooks';
    teacherScope.renderRealScopeBar = false;
    teacherScope.setTeacherScope = vi.fn();
    teacherScope.setLearner = vi.fn();
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
async function render(node: ReactNode) {
    await act(async () => root.render(<LanguageProvider>{node}</LanguageProvider>));
}
async function click(button: Element | null | undefined) {
    if (!(button instanceof HTMLButtonElement)) throw new Error('找不到目标按钮');
    await act(async () => button.click());
}
async function selectValue(select: HTMLSelectElement, value: string) {
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

it('用已配置的英语学科读取标签，年级或章节切换到全部时移除相应过滤条件', async () => {
    api.get.mockImplementation(async (url: string) => {
        if (url === '/api/user') return {};
        if (url.startsWith('/api/tags?')) return { tags: [{ id: 'g', name: '七年级上', children: [{ id: 'c', name: '第一章', children: [] }] }] };
        return { items: [], total: 0, totalPages: 0 };
    });
    await render(<ErrorList subjectId="english-notebook" subject="english" />);
    expect(api.get).toHaveBeenCalledWith('/api/tags?subject=english');
    const [grade, chapter] = container.querySelectorAll<HTMLSelectElement>('select');
    const query = () => {
        const latest = api.get.mock.calls.filter(([url]) => url.startsWith('/api/error-items/list')).at(-1);
        return new URL(latest![0], 'http://localhost').searchParams;
    };
    await selectValue(grade, '七年级上');
    await selectValue(chapter, '第一章');
    expect(query().get('chapter')).toBe('第一章');
    await selectValue(chapter, 'all');
    expect(query().has('chapter')).toBe(false);
    expect(query().get('gradeSemester')).toBe('七年级上');
    await selectValue(grade, 'all');
    expect(query().has('gradeSemester')).toBe(false);
});

it('按班打开错题本时，详情计数、列表请求和打印链接沿用同一班级', async () => {
    api.get.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/notebooks/english-notebook?')) return { id: 'english-notebook', name: '英语', stage: 'junior_high', subjectKey: 'english', _count: { errorItems: 2 } };
        if (url.startsWith('/api/error-items/list?')) return { items: [], total: 0, totalPages: 0 };
        return null;
    });
    await render(<NotebookDetailPage />);
    expect(api.get).toHaveBeenCalledWith('/api/notebooks/english-notebook?classId=class-a');
    const listUrl = api.get.mock.calls.find(([url]) => url.startsWith('/api/error-items/list?'))![0];
    expect(new URL(listUrl, 'http://localhost').searchParams.get('classId')).toBe('class-a');
    await click([...container.querySelectorAll('button')].find(button => button.textContent === zh.notebook.exportPrint));
    expect(router.push).toHaveBeenCalledWith('/print-preview?subjectId=english-notebook&classId=class-a');
});

it.each(['首页', '详情'])('%s 切换到二班后，一班迟到的响应不能覆盖当前显示', async (page) => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    api.get.mockImplementation(async (url: string) => {
        const classId = new URL(url, 'http://localhost').searchParams.get('classId');
        if (url.startsWith('/api/notebooks') && classId) return classId === 'class-a' ? first.promise : second.promise;
        if (url.startsWith('/api/error-items/list?')) return { items: [], total: 0, totalPages: 0 };
        return null;
    });
    const currentPage = () => page === '首页' ? <NotebooksPage /> : <NotebookDetailPage />;
    const notebook = (name: string) => {
        const value = { id: 'english-notebook', name, stage: 'junior_high', subjectKey: 'english', _count: { errorItems: 1 } };
        return page === '首页' ? [value] : value;
    };
    await render(currentPage());
    teacherScope.classId = 'class-b';
    await render(currentPage());
    await act(async () => second.resolve(notebook('二班错题本')));
    expect(container.textContent).toContain('二班错题本');
    await act(async () => first.resolve(notebook('一班错题本')));
    expect(container.textContent).toContain('二班错题本');
    expect(container.textContent).not.toContain('一班错题本');
});

it('删除末页最后一道错题后可以继续看到前页题目', async () => {
    let count = 19;
    api.get.mockImplementation(async (url: string) => {
        if (url === '/api/user') return {};
        const page = Number(new URL(url, 'http://localhost').searchParams.get('page'));
        const start = (page - 1) * 18;
        const items = Array.from({ length: Math.min(18, count - start) }, (_, i) => ({ id: String(start + i + 1) }));
        return { items, total: count, totalPages: Math.ceil(count / 18) };
    });
    api.post.mockImplementation(async () => { count = 18; });
    await render(<ErrorList />);
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label);
    await click(container.querySelector(`button[aria-label="${zh.pagination.next}"]`));
    await click(button(zh.notebook.selectMode));
    await click(container.querySelector('[data-item="19"]'));
    await click(button(zh.notebook.deleteSelected));
    expect(api.post).toHaveBeenCalledWith('/api/error-items/batch-delete', { ids: ['19'] });
    expect(container.querySelectorAll('[data-item]')).toHaveLength(18);
});

it('分批打印可访问第 201 题，切换批次时释放前一批的正文与选项', async () => {
    api.get.mockImplementation(async (url: string) => {
        const params = new URL(url, 'http://localhost').searchParams;
        expect(params.get('subjectId')).toBe('english-notebook');
        expect(params.get('classId')).toBe('class-a');
        expect(params.get('view')).toBe('print');
        const page = Number(params.get('page'));
        const length = page === 1 ? PRINT_PREVIEW_PAGE_SIZE : 1;
        const items = Array.from({ length }, (_, i) => {
            const id = String((page - 1) * PRINT_PREVIEW_PAGE_SIZE + i + 1);
            return { id, questionText: `题干-${id}`, tags: [] };
        });
        return { items, page, pageSize: PRINT_PREVIEW_PAGE_SIZE, total: PRINT_PREVIEW_PAGE_SIZE + 1, totalPages: 2 };
    });
    await render(<PrintPreviewPage />);
    expect(container.querySelector('main')?.textContent).toContain('题干-200');
    await click(container.querySelector(`button[aria-label="${zh.pagination.next}"]`));
    expect(container.querySelector('main')?.textContent).toContain('题干-201');
    expect(container.textContent).not.toContain('题干-200');
});

it('创建错题本遇到重名时保留弹窗及其输入', async () => {
    api.get.mockResolvedValue([]);
    api.post.mockRejectedValue(new Error('conflict'));
    await render(<NotebooksPage />);
    await click(container.querySelector(`button[aria-label="${zh.notebooks.create}"]`));
    const input = document.querySelector<HTMLInputElement>('#name')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '已有错题本');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click([...document.querySelectorAll('button')].find(node => node.textContent === zh.notebooks.dialog.create));
    expect(api.post).toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#name')?.value).toBe('已有错题本');
});

it('TeacherScopeBar 在拉取成功后发现原 classId 已被删除（含班级为空）时自动清除 URL 参数与作用域，且重置按钮兼容失效作用域', async () => {
    teacherScope.renderRealScopeBar = true;
    teacherScope.classId = 'deleted-class';
    teacherScope.learnerId = 'stu-stale';
    teacherScope.search = 'learnerId=stu-stale&studentKey=stu-stale';
    window.history.replaceState(null, '', '/notebooks?learnerId=stu-stale&studentKey=stu-stale');

    // 拉取前（classesLoaded=false）仍保留重置按钮，不误触发自愈
    const deferred = Promise.withResolvers<unknown>();
    api.get.mockImplementationOnce(() => deferred.promise);
    await render(<TeacherScopeBar />);
    expect(container.textContent).toContain(zh.notebooks.teacherScope.reset);
    expect(teacherScope.setTeacherScope).not.toHaveBeenCalled();

    // 拉取返回空班级列表（classesLoaded=true 且 classes.length === 0）时同样触发自愈
    await act(async () => deferred.resolve([]));
    expect(teacherScope.setTeacherScope).toHaveBeenCalledWith(null);
    expect(router.replace).toHaveBeenCalledWith('/notebooks', { scroll: false });
    expect(window.location.search).toBe('');

    // 拉取失败时（classesLoaded=false）不误清有效作用域
    teacherScope.setTeacherScope.mockClear();
    api.get.mockRejectedValueOnce(new Error('network down'));
    await render(<TeacherScopeBar key="network-error" />);
    expect(teacherScope.setTeacherScope).not.toHaveBeenCalled();

    // 若班级列表中存在其他班级但不包含当前 classId，同样触发自愈
    teacherScope.classId = 'deleted-class';
    teacherScope.learnerId = null;
    teacherScope.search = 'learnerId=stu-old';
    api.get.mockResolvedValueOnce([{ id: 'other-class', name: '二班', students: [] }]);
    await render(<TeacherScopeBar key="other-class" />);
    expect(teacherScope.setTeacherScope).toHaveBeenCalledWith(null);
    expect(router.replace).toHaveBeenCalledWith('/notebooks', { scroll: false });
});

it('错题本列表页在失效 classId 导致 404 时配合 TeacherScopeBar 自愈并展示全量列表', async () => {
    teacherScope.renderRealScopeBar = true;
    teacherScope.classId = 'deleted-class';
    teacherScope.setTeacherScope = vi.fn((next) => {
        teacherScope.classId = next?.classId ?? null;
        teacherScope.learnerId = next?.learnerId ?? null;
    });
    api.get.mockImplementation(async (url: string) => {
        if (url === '/api/grading/classes') return [];
        if (url.includes('classId=deleted-class')) {
            throw new ApiError(404, 'Not Found', { error: 'Class not found' });
        }
        return [{ id: 'nb-1', name: '自愈后数学本', stage: 'junior_high', subjectKey: 'math', _count: { errorItems: 3 } }];
    });

    await render(<NotebooksPage />);
    expect(teacherScope.setTeacherScope).toHaveBeenCalledWith(null);
    // 模拟 useCurrentChild 状态更新后页面重渲染
    await render(<NotebooksPage />);
    expect(container.textContent).toContain('自愈后数学本');
});

it('错题本详情页遇到失效 classId 返回 404 Class not found 时自动清理 scope 原地恢复，仅真不存在时才跳回列表', async () => {
    teacherScope.classId = 'deleted-class';
    teacherScope.setTeacherScope = vi.fn((next) => {
        teacherScope.classId = next?.classId ?? null;
        teacherScope.learnerId = next?.learnerId ?? null;
    });
    api.get.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/notebooks/english-notebook?classId=deleted-class')) {
            throw new ApiError(404, 'Not Found', { error: 'Class not found' });
        }
        if (url === '/api/notebooks/english-notebook') {
            return { id: 'english-notebook', name: '英语错题本', stage: 'junior_high', subjectKey: 'english', _count: { errorItems: 1 } };
        }
        if (url.startsWith('/api/tags?')) return { tags: [] };
        if (url.startsWith('/api/error-items/list')) return { items: [], total: 0, totalPages: 0 };
        return {};
    });

    await render(<NotebookDetailPage />);
    expect(teacherScope.setTeacherScope).toHaveBeenCalledWith(null);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    await render(<NotebookDetailPage />);
    expect(container.textContent).toContain('英语错题本');

    // 真正错题本不存在时才提示并跳回列表
    api.get.mockRejectedValueOnce(new ApiError(404, 'Not Found', { error: 'Notebook not found' }));
    await render(<NotebookDetailPage key="not-found" />);
    expect(toastMock.error).toHaveBeenCalledWith(zh.notebooks.notFound);
    expect(router.push).toHaveBeenCalledWith('/notebooks');
});
