// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    session: { user: { id: 'u1', email: 'a@b.com', role: 'user' } },
}));

vi.mock('@/lib/api-client', () => ({
    apiClient: {
        get: mocks.get,
        patch: mocks.patch,
        post: mocks.post,
    },
}));

vi.mock('next-auth/react', () => ({
    useSession: () => ({ data: mocks.session, status: 'authenticated', update: vi.fn() }),
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/contexts/TimeZoneContext', () => ({
    useTimeZone: () => ({ timeZone: 'Asia/Shanghai', setTimeZone: vi.fn() }),
}));

import { SettingsDialog } from '@/components/settings-dialog';
import { LanguageProvider, useLanguage } from '@/contexts/LanguageContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LanguageSwitcherProbe() {
    const { language, setLanguage } = useLanguage();
    return (
        <button type="button" data-testid="lang-toggle" onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
            {language}
        </button>
    );
}

describe('设置页请求去重与无障碍 (OPT-15)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);

        mocks.get.mockImplementation(async (url: string) => {
            if (url === '/api/user') {
                return {
                    id: 'u1',
                    email: 'a@b.com',
                    name: 'Tester',
                    role: 'user',
                    isActive: true,
                    gradeRecognitionMode: 'fixed',
                    fixedGradeSemester: null,
                    questionDuplicateThreshold: 90,
                    masteryThreshold: 50,
                    reviewAlgorithmVersion: 'ebbinghaus-v1',
                    confirmBeforeImport: false,
                    enableGeogebra: false,
                    enableSvgAnimation: true,
                    variantPipelineEnabled: true,
                };
            }
            if (url === '/api/settings') {
                return { aiProvider: 'minimax', timeZone: 'Asia/Shanghai' };
            }
            if (url === '/api/persona') {
                return { personas: ['self'], confirmed: true };
            }
            return {};
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        document.body.innerHTML = '';
    });

    it('打开设置对话框时通过 UserProfileProvider 只发送 1 次 GET /api/user，且 Tab 带 aria-label', async () => {
        await act(async () => {
            root.render(
                <LanguageProvider>
                    <SettingsDialog />
                </LanguageProvider>,
            );
        });

        // 未打开前零 /api/user 请求
        expect(mocks.get.mock.calls.filter(([url]) => url === '/api/user')).toHaveLength(0);

        const trigger = container.querySelector('button');
        expect(trigger).not.toBeNull();
        await act(async () => {
            trigger!.click();
        });
        // 等待异步状态同步
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        const userCalls = mocks.get.mock.calls.filter(([url]) => url === '/api/user');
        expect(userCalls).toHaveLength(1);

        const tabs = Array.from(document.body.querySelectorAll('[role="tab"]'));
        expect(tabs.length).toBeGreaterThanOrEqual(4);
        for (const tab of tabs) {
            const label = tab.getAttribute('aria-label');
            expect(label && label.trim().length > 0).toBe(true);
        }
    });

    it('LanguageProvider 挂载与切换语言时同步更新 html[lang] 属性', async () => {
        await act(async () => {
            root.render(
                <LanguageProvider>
                    <LanguageSwitcherProbe />
                </LanguageProvider>,
            );
        });

        expect(document.documentElement.lang).toBe('zh-CN');

        const button = container.querySelector('[data-testid="lang-toggle"]') as HTMLButtonElement;
        await act(async () => {
            button.click();
        });
        expect(document.documentElement.lang).toBe('en');

        await act(async () => {
            button.click();
        });
        expect(document.documentElement.lang).toBe('zh-CN');
    });
});
