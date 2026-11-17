import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_SETTINGS_EVENT } from "@/components/settings-dialog";
import { SnapshotWarningBanner } from "@/components/snapshot-warning-banner";
import { apiClient } from "@/lib/api-client";
import { translations } from "@/lib/translations";

vi.mock("@/contexts/LanguageContext", () => ({
    useLanguage: () => ({ t: translations.zh, language: "zh" }),
}));

vi.mock("@/lib/api-client", () => ({
    apiClient: {
        get: vi.fn(),
    },
}));

describe("SnapshotWarningBanner", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        host.remove();
        vi.unstubAllGlobals();
    });

    it("快照失败时在首页渲染警告横幅并点击可打开设置", async () => {
        vi.mocked(apiClient.get).mockResolvedValue({
            enabled: true,
            lastError: "permission denied",
        });

        await act(async () => {
            root.render(<SnapshotWarningBanner />);
        });

        const alertEl = host.querySelector('[role="alert"]');
        expect(alertEl).not.toBeNull();
        expect(host.textContent).toContain(translations.zh.settings.dailySnapshotFailedBanner);
        expect(host.textContent).toContain("permission denied");

        const openEvents: string[] = [];
        const onOpen = () => openEvents.push(OPEN_SETTINGS_EVENT);
        window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
        try {
            const btn = host.querySelector("button");
            expect(btn?.textContent).toContain(translations.zh.settings.dailySnapshotOpenSettings);
            await act(async () => {
                btn?.click();
            });
            expect(openEvents).toEqual([OPEN_SETTINGS_EVENT]);
        } finally {
            window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
        }
    });

    it("快照正常或已关闭时不渲染横幅", async () => {
        vi.mocked(apiClient.get).mockResolvedValue({
            enabled: true,
            lastError: null,
        });

        await act(async () => {
            root.render(<SnapshotWarningBanner />);
        });
        expect(apiClient.get).toHaveBeenCalledWith("/api/system/snapshot-status");
        expect(host.innerHTML).toBe("");

        vi.mocked(apiClient.get).mockResolvedValue({
            enabled: false,
            lastError: "old error",
        });
        await act(async () => {
            root.render(<SnapshotWarningBanner />);
        });
        expect(host.innerHTML).toBe("");
    });
});
