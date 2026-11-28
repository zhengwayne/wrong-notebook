// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    accountMountCount: 0,
    userMgmtMountCount: 0,
    get: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
    apiClient: {
        get: mocks.get,
        patch: vi.fn(),
        post: vi.fn(),
    },
}));

vi.mock("next-auth/react", () => ({
    useSession: () => ({
        data: { user: { id: "admin-1", email: "admin@example.com", role: "admin" } },
        status: "authenticated",
    }),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/contexts/TimeZoneContext", () => ({
    useTimeZone: () => ({ timeZone: "Asia/Shanghai", setTimeZone: vi.fn() }),
}));

vi.mock("@/components/settings/account-settings", () => ({
    AccountSettings: () => {
        mocks.accountMountCount += 1;
        return <div data-testid="mock-account-settings">Account Mounted</div>;
    },
}));

vi.mock("@/components/admin/user-management", () => ({
    UserManagement: () => {
        mocks.userMgmtMountCount += 1;
        return <div data-testid="mock-user-management">Users Mounted</div>;
    },
}));

import { SettingsDialog } from "@/components/settings-dialog";
import { LanguageProvider, useLanguage } from "@/contexts/LanguageContext";
import {
    getLoadedAiDailyLimitMessage,
    getLoadedEnglishDictionary,
    loadEnglishDictionary,
    resetEnglishDictionaryCacheForTest,
} from "@/lib/translations/loader";
import { zh } from "@/lib/translations/zh";
import { PrintableQuestion } from "@/components/print-preview/printable-question";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function LanguageProbe() {
    const { language, setLanguage, t } = useLanguage();
    return (
        <div>
            <span data-testid="lang">{language}</span>
            <span data-testid="nav-home">{t.nav.home}</span>
            <button type="button" data-testid="switch-en" onClick={() => setLanguage("en")}>en</button>
        </div>
    );
}

describe("前端首屏减负与按需加载 (OPT-14)", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.accountMountCount = 0;
        mocks.userMgmtMountCount = 0;
        localStorage.clear();
        resetEnglishDictionaryCacheForTest();
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        mocks.get.mockImplementation(async (url: string) => {
            if (url === "/api/user") {
                return {
                    id: "admin-1",
                    email: "admin@example.com",
                    role: "admin",
                    isActive: true,
                    reviewAlgorithmVersion: "ebbinghaus-v1",
                };
            }
            if (url === "/api/settings") {
                return { aiProvider: "minimax", timeZone: "Asia/Shanghai" };
            }
            return {};
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        document.body.innerHTML = "";
        resetEnglishDictionaryCacheForTest();
    });

    it("首屏核心模块不静态导入英文词典与重型设置弹窗或管理员组件", () => {
        const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

        const langCtxSrc = read("src/contexts/LanguageContext.tsx");
        expect(langCtxSrc).not.toMatch(/from\s+['"]@\/lib\/translations['"]/);
        expect(langCtxSrc).not.toMatch(/from\s+['"][^'"]*\/en['"]/);

        const apiClientSrc = read("src/lib/api-client.ts");
        expect(apiClientSrc).not.toMatch(/from\s+['"]@\/lib\/translations['"]/);
        expect(apiClientSrc).not.toMatch(/from\s+['"][^'"]*\/en['"]/);

        const dedupSrc = read("src/lib/question-deduplication.ts");
        expect(dedupSrc).toContain("@/lib/translations/zh");
        expect(dedupSrc).not.toMatch(/from\s+['"]@\/lib\/translations['"]/);

        const shellSrc = read("src/components/app-shell.tsx");
        expect(shellSrc).toContain("next/dynamic");
        expect(shellSrc).not.toMatch(/from\s+['"]@\/components\/settings-dialog['"]/);
        expect(shellSrc).not.toContain("user-management");

        const mdSrc = read("src/components/markdown-renderer.tsx");
        expect(mdSrc).toContain("React.memo");
        expect(mdSrc).toContain("useMemo");
        expect(mdSrc).toContain("REMARK_PLUGINS");
    });

    it("默认同步渲染中文而不加载英文包，切换英文后再异步拉取 en 并更新界面", async () => {
        await act(async () => {
            root.render(
                <LanguageProvider>
                    <LanguageProbe />
                </LanguageProvider>,
            );
        });

        expect(getLoadedEnglishDictionary()).toBeNull();
        expect(container.querySelector('[data-testid="nav-home"]')?.textContent).toBe(zh.nav.home);

        const btn = container.querySelector('[data-testid="switch-en"]') as HTMLButtonElement;
        await act(async () => {
            btn.click();
        });
        await act(async () => {
            await loadEnglishDictionary();
        });

        expect(getLoadedEnglishDictionary()).not.toBeNull();
        expect(container.querySelector('[data-testid="nav-home"]')?.textContent).toBe(getLoadedEnglishDictionary()!.nav.home);
        expect(getLoadedAiDailyLimitMessage("en")).toContain("AI allowance");
    });

    it("SettingsDialog 默认激活 general 标签时零挂载 AccountSettings 与 UserManagement，切到对应标签后按需加载", async () => {
        await act(async () => {
            root.render(
                <LanguageProvider>
                    <SettingsDialog defaultOpen />
                </LanguageProvider>,
            );
        });

        expect(mocks.accountMountCount).toBe(0);
        expect(mocks.userMgmtMountCount).toBe(0);

        const accountTab = document.body.querySelector('[role="tab"][aria-label*="账户"], [role="tab"][aria-label*="Account"]') as HTMLElement | null;
        expect(accountTab).not.toBeNull();
        await act(async () => {
            accountTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            accountTab!.click();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(mocks.accountMountCount).toBe(1);
        expect(mocks.userMgmtMountCount).toBe(0);
    });

    it("PrintableQuestion 在 deferImage=true 时渲染延迟占位而非直接请求 img", async () => {
        const item = {
            id: "q1",
            shortId: "Ab1234",
            questionText: "1+1=?",
            originalImageUrl: "data:image/png;base64,AA==",
            knowledgePoints: "[]",
        };
        const options = {
            showQuestionText: false,
            showAnswers: false,
            showAnalysis: false,
            showTags: false,
            showOriginalImage: true,
            imageScale: 70,
        };

        await act(async () => {
            root.render(
                <LanguageProvider>
                    <PrintableQuestion item={item as never} index={25} options={options} reserveAnswerSpace={false} deferImage />
                </LanguageProvider>,
            );
        });
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector('[data-deferred-image="true"]')).not.toBeNull();

        await act(async () => {
            root.render(
                <LanguageProvider>
                    <PrintableQuestion item={item as never} index={25} options={options} reserveAnswerSpace={false} deferImage={false} />
                </LanguageProvider>,
            );
        });
        expect(container.querySelector("img")).not.toBeNull();
    });
});
