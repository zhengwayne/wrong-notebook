// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    update: vi.fn(),
    session: {
        data: { user: { id: "admin-1", email: "admin@example.com", role: "admin" } },
        status: "authenticated" as string,
        update: vi.fn(),
    },
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
    useSession: () => mocks.session,
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/contexts/TimeZoneContext", () => ({
    useTimeZone: () => ({ timeZone: "Asia/Shanghai", setTimeZone: vi.fn() }),
}));

import { SettingsDialog } from "@/components/settings-dialog";
import { LanguageProvider } from "@/contexts/LanguageContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("设置弹窗切换到账户标签时保持对话框稳定", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.session.data = { user: { id: "admin-1", email: "admin@example.com", role: "admin" } };
        mocks.session.status = "authenticated";
        mocks.session.update = mocks.update;
        mocks.get.mockImplementation(async (url: string) => {
            if (url === "/api/user") {
                return {
                    id: "admin-1",
                    email: "admin@example.com",
                    role: "admin",
                    isActive: true,
                    name: "Admin",
                    educationStage: "junior_high",
                    enrollmentYear: 2025,
                    reviewAlgorithmVersion: "ebbinghaus-v1",
                };
            }
            if (url === "/api/settings") {
                return { aiProvider: "minimax", timeZone: "Asia/Shanghai" };
            }
            if (url === "/api/persona") {
                return { personas: ["self"], confirmed: true };
            }
            return {};
        });
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        document.body.innerHTML = "";
    });

    it("lazy-panels 为账户等按需面板提供本地 loading 骨架，避免 Suspense 冒泡", () => {
        const src = fs.readFileSync(path.join(process.cwd(), "src/components/settings/lazy-panels.tsx"), "utf8");
        expect(src).toMatch(/LazyAccountSettings[\s\S]*loading:\s*\(\)\s*=>\s*<SettingsPanelFallback/);
        expect(src).toContain("SettingsPanelFallback");
        const dialogSrc = fs.readFileSync(path.join(process.cwd(), "src/components/settings-dialog.tsx"), "utf8");
        expect(dialogSrc).toContain('data-testid="settings-dialog"');
        expect(dialogSrc).toContain('data-testid="settings-tab-panel"');
        expect(dialogSrc).toContain("h-[85vh]");
        expect(dialogSrc).toContain("[scrollbar-gutter:stable]");
        expect(dialogSrc).toContain("<Suspense");
    });

    it("从其他标签切到账户时对话框根节点与标题保持同一引用，且不触发 session.update", async () => {
        await act(async () => {
            root.render(
                <LanguageProvider>
                    <SettingsDialog defaultOpen />
                </LanguageProvider>,
            );
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });

        const dialog = document.body.querySelector('[data-testid="settings-dialog"]') as HTMLElement | null
            ?? document.body.querySelector('[role="dialog"]') as HTMLElement | null;
        expect(dialog).not.toBeNull();
        const title = dialog!.querySelector("h2");
        expect(title?.textContent).toMatch(/设置|Settings/);
        const tablist = dialog!.querySelector('[role="tablist"]');
        expect(tablist).not.toBeNull();
        const panel = dialog!.querySelector('[data-testid="settings-tab-panel"]');
        expect(panel).not.toBeNull();

        const accountTab = dialog!.querySelector('[role="tab"][aria-label*="账户"], [role="tab"][aria-label*="Account"]') as HTMLElement | null;
        expect(accountTab).not.toBeNull();
        await act(async () => {
            accountTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            accountTab!.click();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        const dialogAfter = document.body.querySelector('[data-testid="settings-dialog"]') as HTMLElement | null
            ?? document.body.querySelector('[role="dialog"]') as HTMLElement | null;
        expect(dialogAfter).toBe(dialog);
        expect(dialog!.contains(title)).toBe(true);
        expect(dialog!.contains(tablist)).toBe(true);
        expect(dialog!.contains(panel)).toBe(true);
        expect(mocks.update).not.toHaveBeenCalled();
    });
});
