import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ErrorDetailPage from '@/app/error-items/[id]/page';
import LearnPageRoute from '@/app/learn/page';
import ParentHomePage from '@/app/parent/page';
import ParentPapersPage from '@/app/parent/papers/page';
import { AppShell } from '@/components/app-shell';
import { BackgroundTasksButton } from '@/components/background-tasks-button';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { TimeZoneProvider } from '@/contexts/TimeZoneContext';
import { ApiError } from '@/lib/api-client';
import { withChildParam } from '@/lib/current-child';
import { zh } from '@/lib/translations/zh';

const routerMock = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    setLearner: vi.fn(),
    query: 'learnerId=A',
    replace: routerMock.replace,
    push: routerMock.push,
    pathname: '/learn',
    itemId: 'item-1',
    role: 'user' as 'user' | 'admin',
    persona: 'parent' as 'parent' | 'teacher' | 'student',
    sessionStatus: 'authenticated' as 'authenticated' | 'unauthenticated',
    isParent: true,
    learnerId: 'A' as string | null,
    childName: 'A',
    hrefWithChild: (href: string) => href,
    kidMode: null as { active: boolean; learnerId: string | null; learnerName: string | null; hasPin: boolean; lockedUntil: string | null } | null,
    useSetupRedirect: vi.fn(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api-client')>();
    return {
        ApiError: actual.ApiError,
        apiClient: { get: mocks.get, post: mocks.post, patch: mocks.patch, delete: mocks.delete },
    };
});
vi.mock('next/navigation', () => ({
    useRouter: () => routerMock,
    useSearchParams: () => new URLSearchParams(mocks.query),
    useParams: () => ({ id: mocks.itemId }),
    usePathname: () => mocks.pathname,
}));
vi.mock('next-auth/react', () => ({
    useSession: () => ({
        data: mocks.sessionStatus === 'authenticated'
            ? { user: { name: '家长', email: 'parent@example.com', role: mocks.role, activePersona: mocks.persona } }
            : null,
        status: mocks.sessionStatus,
    }),
    signOut: vi.fn(),
}));
vi.mock('next/image', () => ({
    default: ({ alt }: { alt?: string }) => <span data-testid="mock-img">{alt ?? ''}</span>,
}));
vi.mock('@/lib/use-current-child', () => ({
    useCurrentChild: () => ({
        isParent: mocks.isParent,
        isTeacher: false,
        learnerId: mocks.learnerId,
        childName: mocks.childName,
        setLearner: mocks.setLearner,
        hrefWithChild: mocks.hrefWithChild,
    }),
}));
vi.mock('@/components/parent/kid-mode-lock-bar', () => ({
    ParentKidModeCard: ({ learnerId }: { learnerId: string }) => <div data-child={learnerId} />,
    GlobalKidModeBanner: () => <div data-testid="kid-banner" />,
    KID_MODE_CHANGED_EVENT: 'wn:kid-mode-changed',
    useKidModeState: () => ({ state: mocks.kidMode, reload: vi.fn() }),
}));
vi.mock('@/lib/use-setup-redirect', () => ({ useSetupRedirect: mocks.useSetupRedirect }));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/persona-switcher', () => ({ PersonaSwitcher: () => null }));
vi.mock('@/components/layout/mobile-nav', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/layout/mobile-nav')>();
    return { ...actual, MobileNav: () => null };
});
vi.mock('@/components/learn/step-note-editor', () => ({ StepNoteEditor: () => null }));
vi.mock('@/components/source-question-list', () => ({ SourceQuestionList: () => null }));
vi.mock('@/components/error-detail/question-card', () => ({ QuestionCard: () => <div data-testid="question-card" /> }));
vi.mock('@/components/error-detail/wrong-answer-card', () => ({ WrongAnswerCard: () => <div data-testid="wrong-answer-card" /> }));
vi.mock('@/components/error-detail/notes-card', () => ({ NotesCard: () => <div data-testid="notes-card" /> }));
vi.mock('@/components/error-item-learning-card', () => ({ ErrorItemLearningCard: () => <div data-testid="learning-card" /> }));
vi.mock('@/components/mastery-panel', () => ({ MasteryPanel: () => <div data-testid="mastery-panel" /> }));
vi.mock('@/components/svg-animation-explainer', () => ({ SvgAnimationExplainer: () => null }));
vi.mock('@/components/error-detail/geogebra-section', () => ({ GeogebraSection: () => null }));
vi.mock('@/components/fix-latex-button', () => ({ FixLatexButton: () => <button type="button" data-testid="fix-latex-btn">Fix</button> }));
vi.mock('@/components/regenerate-answer-button', () => ({ RegenerateAnswerButton: () => <button type="button" data-testid="regen-answer-btn">Regen</button> }));
vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/feedback', () => ({ confirmDialog: async () => true, toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

beforeEach(() => {
    vi.clearAllMocks();
    mocks.query = 'learnerId=A';
    mocks.pathname = '/learn';
    mocks.itemId = 'item-1';
    mocks.role = 'user';
    mocks.persona = 'parent';
    mocks.sessionStatus = 'authenticated';
    mocks.isParent = true;
    mocks.learnerId = 'A';
    mocks.childName = 'A';
    mocks.hrefWithChild = (href: string) => href;
    mocks.kidMode = null;
});

afterEach(() => {
    vi.useRealTimers();
});

it('快速切换孩子后仅展示最后一次选择的首页，并立即移除前一人的作业操作', async () => {
    const choices = ['A', 'B', 'C'].map(id => ({ id, name: id }));
    const home = (id: string) => ({
        selectedLearnerId: id, children: choices,
        child: { id, name: id, weakPoints: [], mastery: [], today: [], practiceTrend: [], practiceSummary: { attempted: 0, correct: 0 }, latestPaper: null },
    });
    const finish = new Map<string, () => void>();
    mocks.get.mockImplementation(async (url: string) => {
        const { pathname, searchParams } = new URL(url, 'http://localhost');
        const id = searchParams.get('learnerId')!;
        if (pathname === '/api/parent/homeworks') {
            if (id !== 'A') return new Promise(() => {});
            return {
                items: [{ id: 'a1', title: 'A 的作业', subjectKey: 'math', category: 'written' }],
                summary: { total: 1, completed: 0, estimatedMinutes: 0, streakDays: 0 },
            };
        }
        if (id === 'A') return home(id);
        return new Promise(resolve => finish.set(id, () => resolve(home(id))));
    });

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () => act(async () => root.render(<LanguageProvider><ParentHomePage /></LanguageProvider>));
    try {
        await render();
        expect(container.textContent).toContain('A 的作业');
        for (const id of ['B', 'C']) {
            const button = [...container.querySelectorAll('button')].find(node => node.textContent === id)!;
            await act(async () => button.click());
            mocks.query = new URL(mocks.replace.mock.lastCall![0], 'http://localhost').search.slice(1);
            await render();
            expect(container.textContent).not.toContain('A 的作业');
        }
        await act(async () => finish.get('C')!());
        expect(container.textContent).not.toContain('A 的作业');
        await act(async () => finish.get('B')!());
        expect(container.querySelector('[data-child]')?.getAttribute('data-child')).toBe('C');
        expect(mocks.setLearner.mock.lastCall).toEqual([{ id: 'C', name: 'C' }]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});

it('家长首页加载只随 learnerId 变化：其他网址参数变化不重复拉取，失效孩子纠正网址时保留其他参数', async () => {
    const homeCalls: string[] = [];
    mocks.query = 'learnerId=GONE&tab=week';
    mocks.get.mockImplementation(async (url: string) => {
        const { pathname, searchParams } = new URL(url, 'http://localhost');
        if (pathname === '/api/parent/homeworks') {
            return { items: [], summary: { total: 0, completed: 0, estimatedMinutes: 0, streakDays: 0 } };
        }
        if (pathname === '/api/onboarding') return null;
        homeCalls.push(searchParams.get('learnerId') ?? '');
        return {
            selectedLearnerId: 'A', children: [{ id: 'A', name: 'A' }],
            child: { id: 'A', name: 'A', weakPoints: [], mastery: [], today: [], practiceTrend: [], practiceSummary: { attempted: 0, correct: 0 }, latestPaper: null },
        };
    });

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () => act(async () => root.render(<LanguageProvider><ParentHomePage /></LanguageProvider>));
    try {
        await render();
        expect(homeCalls).toEqual(['GONE']);
        expect(mocks.replace).toHaveBeenCalledTimes(1);
        const redirected = new URL(mocks.replace.mock.lastCall![0], 'http://localhost');
        expect(redirected.searchParams.get('learnerId')).toBe('A');
        expect(redirected.searchParams.get('tab')).toBe('week');

        mocks.query = 'learnerId=A&tab=week';
        await render();
        expect(homeCalls).toEqual(['GONE', 'A']);

        // 只改其他参数时不再请求首页数据
        mocks.query = 'learnerId=A&tab=month';
        await render();
        expect(homeCalls).toEqual(['GONE', 'A']);
        expect(mocks.replace).toHaveBeenCalledTimes(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});

it('家长试卷列表页切娃时立即清空旧数据，并丢弃在途轮询响应与旧定时器回调', async () => {
    vi.useFakeTimers();
    const pendingPollA = Promise.withResolvers<{ papers: Array<{ id: string; learnerId: string; learnerName: string; title: string; status: string; pageCount: number; createdAt: string }> }>();
    const pendingLoadB = Promise.withResolvers<{ papers: Array<{ id: string; learnerId: string; learnerName: string; title: string; status: string; pageCount: number; createdAt: string }> }>();
    let aCallCount = 0;

    mocks.get.mockImplementation(async (url: string) => {
        const id = new URL(url, 'http://localhost').searchParams.get('learnerId');
        if (id === 'A') {
            aCallCount += 1;
            if (aCallCount === 1) {
                return {
                    papers: [{
                        id: 'p-a1', learnerId: 'A', learnerName: 'A',
                        title: 'A 的识别中试卷', status: 'recognizing', pageCount: 1, createdAt: '2026-11-19T10:00:00Z',
                    }],
                };
            }
            return pendingPollA.promise;
        }
        return pendingLoadB.promise;
    });

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderPapers = () => act(async () => root.render(
        <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><ParentPapersPage /></TimeZoneProvider></LanguageProvider>,
    ));

    try {
        mocks.learnerId = 'A';
        mocks.childName = 'A';
        await renderPapers();
        expect(container.textContent).toContain('A 的识别中试卷');

        // 触发 A 的 2000ms 轮询（产生在途请求 pendingPollA）
        await act(async () => {
            vi.advanceTimersByTime(2000);
        });
        expect(aCallCount).toBe(2);

        // 切换到孩子 B：应立即清空 A 的试卷，不再显示 A 的内容
        mocks.learnerId = 'B';
        mocks.childName = 'B';
        await renderPapers();
        expect(container.textContent).not.toContain('A 的识别中试卷');

        // B 的列表先返回，随后 A 的在途轮询响应才迟到到达：不得覆盖 B 的页面
        await act(async () => {
            pendingLoadB.resolve({
                papers: [{
                    id: 'p-b1', learnerId: 'B', learnerName: 'B',
                    title: 'B 的数学试卷', status: 'done', pageCount: 2, createdAt: '2026-11-19T11:00:00Z',
                }],
            });
        });
        expect(container.textContent).toContain('B 的数学试卷');

        await act(async () => {
            pendingPollA.resolve({
                papers: [{
                    id: 'p-a1', learnerId: 'A', learnerName: 'A',
                    title: 'A 迟到的轮询试卷', status: 'done', pageCount: 1, createdAt: '2026-11-19T10:00:00Z',
                }],
            });
        });
        expect(container.textContent).toContain('B 的数学试卷');
        expect(container.textContent).not.toContain('A 迟到的轮询试卷');
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});

it('学习路径页在专注模式下保留孩子参数、屏蔽 /variants 兜底、隐藏管理控件且 checkpoint 回退代表题或 /review', async () => {
    mocks.isParent = false;
    mocks.learnerId = 'child-1';
    mocks.hrefWithChild = (href: string) => withChildParam(href, 'child-1');
    mocks.query = 'studentKey=child-1&tab=class';
    mocks.kidMode = { active: true, learnerId: 'child-1', learnerName: '小明', hasPin: true, lockedUntil: null };

    const pathPayload = {
        id: 'path-1',
        studentKey: 'child-1',
        studentName: '小明',
        classId: null,
        version: 2,
        planReason: '重点练习',
        plannedAt: '2026-11-19T10:00:00Z',
        steps: [
            { id: 's1', type: 'review_explanation', title: '看解析', reason: 'r1', knowledgePoints: ['方程'], errorItemIds: ['item-99'], href: '/error-items/item-99', status: 'pending', locked: false },
            { id: 's2', type: 'variant_practice', title: '无题变式', reason: 'r2', knowledgePoints: ['方程'], errorItemIds: [], href: '/variants', status: 'pending', locked: false },
            { id: 's3', type: 'checkpoint', title: '检查点', reason: 'r3', knowledgePoints: ['方程'], errorItemIds: [], href: '/practice', status: 'pending', locked: false },
        ],
        today: [] as unknown[],
        mastery: [],
    };
    pathPayload.today = pathPayload.steps;

    mocks.get.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/learning-path?')) return pathPayload;
        throw new Error(`Unexpected GET ${url}`);
    });

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await act(async () => root.render(
            <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><LearnPageRoute /></TimeZoneProvider></LanguageProvider>,
        ));

        // 专注锁下即使 URL 带 tab=class 也不请求班级接口且隐藏班级 Tab、“本人”按钮
        expect(mocks.get).not.toHaveBeenCalledWith(expect.stringContaining('/api/learning-path/class'));
        expect(container.textContent).not.toContain(zh.learn.tabClass);
        expect(container.textContent).not.toContain(zh.learn.me);

        const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
        expect(links).toContain('/error-items/item-99?learnerId=child-1');
        expect(links).toContain('/practice?itemId=item-99&learnerId=child-1');
        expect(links.some((href) => href?.startsWith('/variants'))).toBe(false);

        // 全路径均无 errorItemIds 时，checkpoint 回退 /review 并保留孩子上下文；空列表时不显示重新规划按钮
        mocks.get.mockResolvedValueOnce({
            ...pathPayload,
            steps: [{ id: 's-cp', type: 'checkpoint', title: '空检查点', reason: 'r', knowledgePoints: [], errorItemIds: [], href: '/practice', status: 'pending', locked: false }],
            today: [{ id: 's-cp', type: 'checkpoint', title: '空检查点', reason: 'r', knowledgePoints: [], errorItemIds: [], href: '/practice', status: 'pending', locked: false }],
        });
        await act(async () => root.render(
            <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><LearnPageRoute key="no-items" /></TimeZoneProvider></LanguageProvider>,
        ));
        expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('/review?learnerId=child-1');

        mocks.get.mockResolvedValueOnce({ ...pathPayload, steps: [], today: [] });
        await act(async () => root.render(
            <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><LearnPageRoute key="empty-path" /></TimeZoneProvider></LanguageProvider>,
        ));
        expect([...container.querySelectorAll('button')].some((btn) => btn.textContent?.includes(zh.learn.replan))).toBe(false);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});

it('后台任务按钮在专注锁下隐藏且不轮询；遇 403 停轮询并在解锁事件后恢复；AppShell 向 useSetupRedirect 传入 !kidLocked', async () => {
    vi.useFakeTimers();
    mocks.pathname = '/learn';
    mocks.role = 'admin';
    mocks.kidMode = { active: true, learnerId: 'child-1', learnerName: '小明', hasPin: true, lockedUntil: null };

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await act(async () => root.render(
            <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><AppShell><BackgroundTasksButton /></AppShell></TimeZoneProvider></LanguageProvider>,
        ));
        expect(mocks.useSetupRedirect).toHaveBeenCalledWith(false);
        await act(async () => { vi.advanceTimersByTime(20000); });
        expect(mocks.get).not.toHaveBeenCalledWith('/api/tasks');
        expect(container.querySelector(`button[aria-label="${zh.backgroundTasks.title}"]`)).toBeNull();

        // 模拟首帧尚未知晓专注锁时 /api/tasks 返回 403：应停止后续轮询，直到收到 KID_MODE_CHANGED_EVENT
        mocks.kidMode = null;
        mocks.get.mockRejectedValue(new ApiError(403, 'Forbidden', { code: 'KID_MODE_RESTRICTED' }));
        await act(async () => root.render(
            <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><BackgroundTasksButton /></TimeZoneProvider></LanguageProvider>,
        ));
        await act(async () => { vi.advanceTimersByTime(0); });
        expect(mocks.get).toHaveBeenCalledTimes(1);

        await act(async () => { vi.advanceTimersByTime(30000); });
        expect(mocks.get).toHaveBeenCalledTimes(1);

        mocks.get.mockResolvedValue({ tasks: [] });
        await act(async () => {
            window.dispatchEvent(new Event('wn:kid-mode-changed'));
        });
        await act(async () => {
            vi.advanceTimersByTime(0);
        });
        expect(mocks.get).toHaveBeenCalledTimes(2);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});

it('错题详情页在专注锁下返回 /learn，禁用难度星级并隐藏写删按钮', async () => {
    mocks.kidMode = { active: true, learnerId: 'child-1', learnerName: '小明', hasPin: true, lockedUntil: null };
    mocks.get.mockImplementation(async (url: string) => {
        if (url === '/api/user') return { enableSvgAnimation: false, enableGeogebra: false };
        if (url === '/api/error-items/item-1') {
            return {
                id: 'item-1',
                shortId: 'Ab1234',
                subjectId: 'nb-1',
                questionText: '1 + 1 = ?',
                answerText: '2',
                analysis: '基础加法',
                difficultyStars: 3,
                tags: [],
            };
        }
        return {};
    });

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await act(async () => root.render(
            <LanguageProvider><TimeZoneProvider initialTimeZone="Asia/Taipei"><ErrorDetailPage /></TimeZoneProvider></LanguageProvider>,
        ));
        expect(container.querySelector('a[href="/learn"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="fix-latex-btn"]')).toBeNull();
        expect(container.querySelector('[data-testid="regen-answer-btn"]')).toBeNull();
        expect(container.textContent).not.toContain(zh.detail.delete);
        const starButtons = [...container.querySelectorAll('div[role="group"] button, span[role="group"] button')];
        expect(starButtons.length).toBe(5);
        expect(starButtons.every((btn) => (btn as HTMLButtonElement).disabled)).toBe(true);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    }
});
