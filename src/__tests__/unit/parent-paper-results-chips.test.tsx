/**
 * 识卷结果汇总的错因/知识点标签应走 MarkdownRenderer，以渲染行内 LaTeX。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ParentPaperResults } from "@/components/parent/parent-paper-results";

vi.mock("@/components/markdown-renderer", () => ({
    MarkdownRenderer: ({ content }: { content: string }) => <span data-testid="latex-chip">{content}</span>,
}));

let root: Root;
let host: HTMLDivElement;

async function renderResults() {
    await act(async () => {
        root.render(
            <LanguageProvider>
                <ParentPaperResults
                    summary={{
                        total: 2,
                        correct: 0,
                        wrong: 1,
                        partial: 1,
                        needsConfirmation: 0,
                        errorCauses: [String.raw`计算 $15 \times 14$ 时出错`],
                        knowledgePoints: [String.raw`$180^\circ$`],
                    }}
                    hasAnswerKey={false}
                    scoreLabel={null}
                    confirmed={false}
                    importedNotebooks={[]}
                    importedCount={0}
                    hrefWithChild={(href) => href}
                />
            </LanguageProvider>,
        );
    });
}

beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await renderResults();
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    vi.unstubAllGlobals();
});

describe("ParentPaperResults chips", () => {
    it("renders error-cause and knowledge-point chips through MarkdownRenderer instead of raw TeX", async () => {
        const chips = [...host.querySelectorAll('[data-testid="latex-chip"]')].map((node) => node.textContent);
        expect(chips).toContain(String.raw`计算 $15 \times 14$ 时出错`);
        expect(chips).toContain(String.raw`$180^\circ$`);
    });
});
