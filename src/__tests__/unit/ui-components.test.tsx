import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import Link from "next/link";
import { BookOpen } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
    error: vi.fn(),
    warn: vi.fn(),
}));

vi.mock("@/lib/frontend-logger", () => ({
    frontendLogger: loggerMocks,
}));

import { ErrorItemCard } from "@/components/error-list/error-item-card";
import { NotebookCard } from "@/components/notebook-card";
import { ActiveFilterBar } from "@/components/ui/active-filter-bar";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { TimeZoneProvider } from "@/contexts/TimeZoneContext";
import type { ErrorItemSummary } from "@/types/api";

let root: Root;
let container: HTMLDivElement;

function TestProviders({ children }: { children: React.ReactNode }) {
    return (
        <LanguageProvider>
            <TimeZoneProvider initialTimeZone="Asia/Shanghai">{children}</TimeZoneProvider>
        </LanguageProvider>
    );
}

async function mount(node: React.ReactNode) {
    await act(async () => {
        root.render(<TestProviders>{node}</TestProviders>);
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.setItem("app-language", "zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
});

describe("Button 异步加载与无障碍支持", () => {
    it("loading 时禁用点击、标记 aria-busy 并支持 loadingText", async () => {
        const onClick = vi.fn();
        await mount(
            <Button loading loadingText="保存中..." onClick={onClick}>
                保存
            </Button>
        );

        const btn = container.querySelector("button")!;
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute("aria-busy")).toBe("true");
        expect(btn.textContent).toContain("保存中...");

        act(() => btn.click());
        expect(onClick).not.toHaveBeenCalled();
    });

    it("asChild 模式兼容子链接且不因多子节点报错", async () => {
        await mount(
            <Button asChild loading>
                <Link href="/notebooks">前往错题本</Link>
            </Button>
        );
        const link = container.querySelector("a")!;
        expect(link.getAttribute("href")).toBe("/notebooks");
        expect(link.getAttribute("aria-busy")).toBe("true");
    });
});

describe("AsyncBoundary 四态异步容器", () => {
    it("首屏加载时渲染带无障碍播报的骨架屏", async () => {
        await mount(
            <AsyncBoundary loading hasData={false} loadingLabel="正在加载数据">
                <div>正文内容</div>
            </AsyncBoundary>
        );
        const status = container.querySelector('[role="status"]')!;
        expect(status.getAttribute("aria-busy")).toBe("true");
        expect(container.textContent).toContain("正在加载数据");
        expect(container.textContent).not.toContain("正文内容");
    });

    it("请求失败且无旧数据时展示错误态并支持一键重试", async () => {
        const onRetry = vi.fn();
        await mount(
            <AsyncBoundary loading={false} error="网络连接超时" hasData={false} onRetry={onRetry}>
                <div>正文内容</div>
            </AsyncBoundary>
        );
        const alert = container.querySelector('[role="alert"]')!;
        expect(alert.textContent).toContain("网络连接超时");
        const retryBtn = alert.querySelector("button")!;
        act(() => retryBtn.click());
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("已有旧数据但后台重刷报错时保留旧数据并展示紧凑告警条", async () => {
        await mount(
            <AsyncBoundary loading={false} error="刷新失败" hasData>
                <div>缓存的错题列表</div>
            </AsyncBoundary>
        );
        expect(container.querySelector('[role="alert"]')?.textContent).toContain("刷新失败");
        expect(container.textContent).toContain("缓存的错题列表");
    });

    it("数据为空且无错误时渲染 emptyFallback", async () => {
        await mount(
            <AsyncBoundary
                loading={false}
                empty
                emptyFallback={<EmptyState icon={BookOpen} title="暂无错题本" />}
            >
                <div>列表</div>
            </AsyncBoundary>
        );
        expect(container.textContent).toContain("暂无错题本");
        expect(container.textContent).not.toContain("列表");
    });
});

describe("ErrorBoundary 渲染崩溃隔离", () => {
    it("捕获子组件渲染异常并支持重置恢复", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        let shouldThrow = true;

        function FlakyChild() {
            if (shouldThrow) throw new Error("Boom");
            return <div>正常恢复的视图</div>;
        }

        await mount(
            <ErrorBoundary>
                <FlakyChild />
            </ErrorBoundary>
        );

        expect(container.querySelector('[role="alert"]')?.textContent).toContain("界面出现异常");
        expect(loggerMocks.error).toHaveBeenCalledTimes(1);

        shouldThrow = false;
        const reloadBtn = container.querySelector("button")!;
        await act(async () => {
            reloadBtn.click();
        });
        expect(container.textContent).toContain("正常恢复的视图");
        consoleSpy.mockRestore();
    });
});

describe("SegmentedControl 键盘漫游无障碍", () => {
    it("维护 Roving tabIndex 并支持左右方向键与首尾键跳过禁用项切换", async () => {
        function Harness() {
            const [val, setVal] = useState<"a" | "b" | "c">("a");
            return (
                <SegmentedControl
                    ariaLabel="模式切换"
                    value={val}
                    onChange={setVal}
                    options={[
                        { value: "a", label: "拍照" },
                        { value: "b", label: "禁用项", disabled: true },
                        { value: "c", label: "手写" },
                    ]}
                />
            );
        }

        await mount(<Harness />);
        const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
        expect(tabs[0].tabIndex).toBe(0);
        expect(tabs[2].tabIndex).toBe(-1);

        // 右方向键应跳过禁用的 b，直接激活并聚焦 c
        await act(async () => {
            tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        });
        expect(tabs[2].getAttribute("aria-selected")).toBe("true");
        expect(document.activeElement).toBe(tabs[2]);

        // Home 键回到首个可用项 a
        await act(async () => {
            tabs[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        });
        expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    });
});

describe("SearchInput 与 ActiveFilterBar", () => {
    it("SearchInput 支持 Escape 与清除按钮清空输入", async () => {
        function SearchHarness() {
            const [q, setQ] = useState("二次函数");
            return <SearchInput value={q} onValueChange={setQ} placeholder="搜索题目" />;
        }

        await mount(<SearchHarness />);
        const input = container.querySelector("input")!;
        expect(input.value).toBe("二次函数");

        await act(async () => {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(input.value).toBe("");
        expect(container.querySelector('button[aria-label="清空搜索"]')).toBeNull();
    });

    it("ActiveFilterBar 支持移除单个筛选与一键清空全部", async () => {
        const removeMastery = vi.fn();
        const clearAll = vi.fn();
        await mount(
            <ActiveFilterBar
                items={[
                    { key: "m", label: "待复习", onRemove: removeMastery },
                    { key: "t", label: "勾股定理", onRemove: vi.fn() },
                ]}
                onClearAll={clearAll}
            />
        );
        const chipBtn = container.querySelector<HTMLButtonElement>('button[aria-label="移除筛选：待复习"]')!;
        act(() => chipBtn.click());
        expect(removeMastery).toHaveBeenCalledTimes(1);

        const clearBtn = Array.from(container.querySelectorAll("button")).find((b) =>
            b.textContent?.includes("清空筛选")
        )!;
        act(() => clearBtn.click());
        expect(clearAll).toHaveBeenCalledTimes(1);
    });
});

describe("NotebookCard 与 ErrorItemCard 语义化与无嵌套交互", () => {
    const sampleItem: ErrorItemSummary = {
        id: "item-1",
        shortId: "AB12CD",
        questionText: "已知 $x + y = 3$，求 $x^2 + y^2$ 的最小值。",
        mistakeStatus: "calculation_error",
        masteryStatus: "new",
        masteryProbability: 0.42,
        difficultyStars: 3,
        knowledgePoints: '["代数恒等式","均值不等式","配方法","最值问题"]',
        tags: [],
        createdAt: "2026-10-20T08:00:00.000Z",
    };

    it("NotebookCard 传入 href 时渲染原生语义化链接", async () => {
        await mount(<NotebookCard name="高中数学" errorCount={12} href="/notebooks/math-1" itemLabel="题" />);
        const link = container.querySelector("a")!;
        expect(link.getAttribute("href")).toBe("/notebooks/math-1");
        expect(link.textContent).toContain("高中数学");
        expect(link.textContent).toContain("12");
    });

    it("ErrorItemCard 将知识点按钮移出 <a> 链接，支持键盘独立筛选与展开标签", async () => {
        const onTagClick = vi.fn();
        const onToggleSelect = vi.fn();
        await mount(
            <ErrorItemCard
                item={sampleItem}
                selectMode={false}
                selected={false}
                onToggleSelect={onToggleSelect}
                selectedTag="均值不等式"
                onTagClick={onTagClick}
            />
        );

        const mainLink = container.querySelector("a")!;
        // 确保 <a> 内部没有任何嵌套的 <button>
        expect(mainLink.querySelectorAll("button").length).toBe(0);

        const selectedTagBtn = Array.from(container.querySelectorAll("button")).find(
            (b) => b.textContent === "均值不等式"
        )!;
        expect(selectedTagBtn.getAttribute("aria-pressed")).toBe("true");
        act(() => selectedTagBtn.click());
        expect(onTagClick).toHaveBeenCalledWith("均值不等式");

        // 点击展开更多标签按钮
        const expandBtn = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
        expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
        await act(async () => {
            expandBtn.click();
        });
        expect(expandBtn.getAttribute("aria-expanded")).toBe("true");
        expect(container.textContent).toContain("最值问题");
    });
});
