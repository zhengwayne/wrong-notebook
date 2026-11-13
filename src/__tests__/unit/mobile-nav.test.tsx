import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMobileMoreActive, isMobilePrimaryActive, MOBILE_MORE_ITEMS, MOBILE_PRIMARY_ITEMS } from "@/lib/nav-items";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { TimeZoneProvider } from "@/contexts/TimeZoneContext";

const navState = vi.hoisted(() => ({ pathname: "/" }));
const sessionState = vi.hoisted(() => ({
    role: "user" as "user" | "admin",
    status: "authenticated" as "authenticated" | "unauthenticated",
}));

vi.mock("next/navigation", () => ({
    usePathname: () => navState.pathname,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("next-auth/react", () => ({
    useSession: () => ({
        data: sessionState.status === "authenticated"
            ? { user: { name: "示例老师", email: "teacher@example.com", role: sessionState.role } }
            : null,
        status: sessionState.status,
    }),
    signOut: vi.fn(),
}));

vi.mock("next/image", () => ({
    default: (props: { alt?: string }) => <span data-testid="logo">{props.alt ?? ""}</span>,
}));

vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => <button type="button">主题</button> }));
vi.mock("@/components/settings-dialog", () => ({
    SettingsDialog: () => <button type="button">顶栏设置</button>,
    requestOpenSettings: vi.fn(),
}));
vi.mock("@/lib/use-setup-redirect", () => ({ useSetupRedirect: () => undefined }));

import { AppShell } from "@/components/app-shell";
import { requestOpenSettings } from "@/components/settings-dialog";

let root: Root;
let container: HTMLDivElement;

async function mount() {
    await act(async () => {
        root.render(
            <LanguageProvider>
                <TimeZoneProvider initialTimeZone="Asia/Taipei">
                    <AppShell>
                        <main id="main-content">内容</main>
                    </AppShell>
                </TimeZoneProvider>
            </LanguageProvider>
        );
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    navState.pathname = "/";
    sessionState.role = "user";
    sessionState.status = "authenticated";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("app-language", "zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe("移动端主导航与「更多」分流", () => {
    it("首页、错题本、学习、改卷算作底栏主入口，复习/变式/统计/试卷算作更多", () => {
        expect(MOBILE_PRIMARY_ITEMS.map((item) => item.key)).toEqual(["home", "notebooks", "learn", "grading"]);
        expect(MOBILE_MORE_ITEMS.map((item) => item.key)).toEqual(["review", "variants", "stats", "exams"]);
        expect(isMobilePrimaryActive("/")).toBe(true);
        expect(isMobilePrimaryActive("/notebooks/abc")).toBe(true);
        expect(isMobilePrimaryActive("/error-items/1")).toBe(true);
        expect(isMobilePrimaryActive("/practice")).toBe(true);
        expect(isMobilePrimaryActive("/learn")).toBe(true);
        expect(isMobilePrimaryActive("/grading/t1")).toBe(true);
        expect(isMobileMoreActive("/review")).toBe(true);
        expect(isMobileMoreActive("/variants")).toBe(true);
        expect(isMobileMoreActive("/stats?tab=tags")).toBe(true);
        expect(isMobileMoreActive("/tags")).toBe(true);
        expect(isMobileMoreActive("/exams/1")).toBe(true);
        expect(isMobileMoreActive("/admin/user/1")).toBe(true);
        expect(isMobileMoreActive("/learn")).toBe(false);
        expect(isMobilePrimaryActive("/review")).toBe(false);
    });

    it("底栏只展示四个主入口和「更多」，位于复习页时高亮更多", async () => {
        navState.pathname = "/review";
        await mount();
        const bar = container.querySelector('nav[aria-label="底部导航"]')!;
        const labels = [...bar.querySelectorAll("a, button")].map((el) => el.textContent?.replace(/\s+/g, "").trim());
        expect(labels).toEqual(["录入", "错题本", "学习", "改卷", "更多"]);
        const more = bar.querySelector("button")!;
        expect(more.getAttribute("aria-current")).toBe("true");
        expect(more.getAttribute("aria-haspopup")).toBe("dialog");
        expect(more.getAttribute("aria-expanded")).toBe("false");
        expect(bar.querySelector('a[href="/review"]')).toBeNull();
    });

    it("打开更多面板后可看到其余入口，Esc 关闭并将焦点交回按钮", async () => {
        navState.pathname = "/stats";
        await mount();
        const more = container.querySelector('nav[aria-label="底部导航"] button') as HTMLButtonElement;
        await act(async () => {
            more.click();
        });
        expect(more.getAttribute("aria-expanded")).toBe("true");
        const dialog = document.querySelector("[role='dialog']") as HTMLElement;
        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
        expect(document.body.textContent).toContain("复习");
        expect(document.body.textContent).toContain("变式审核");
        expect(document.body.textContent).toContain("统计");
        expect(document.body.textContent).toContain("试卷");
        expect(document.body.textContent).toContain("设置");
        const stats = document.querySelector('a[href="/stats"]');
        expect(stats?.getAttribute("aria-current")).toBe("page");

        await act(async () => {
            dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(document.querySelector("[role='dialog']")).toBeNull();
        expect(more.getAttribute("aria-expanded")).toBe("false");
    });

    it("更多里的设置会关闭面板并请求打开已有设置对话框", async () => {
        await mount();
        const more = container.querySelector('nav[aria-label="底部导航"] button') as HTMLButtonElement;
        await act(async () => { more.click(); });
        const settings = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("设置") && el.textContent !== "顶栏设置");
        expect(settings).toBeTruthy();
        await act(async () => { settings!.click(); });
        expect(document.querySelector("[role='dialog']")).toBeNull();
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(requestOpenSettings).toHaveBeenCalled();
    });

    it("管理员能在更多中看到管理入口", async () => {
        sessionState.role = "admin";
        navState.pathname = "/notebooks";
        await mount();
        const more = container.querySelector('nav[aria-label="底部导航"] button') as HTMLButtonElement;
        expect(more.getAttribute("aria-current")).toBeNull();
        await act(async () => { more.click(); });
        const dialog = document.querySelector("[role='dialog']");
        expect(dialog?.querySelector('a[href="/admin"]')?.textContent).toContain("管理");
    });
});
