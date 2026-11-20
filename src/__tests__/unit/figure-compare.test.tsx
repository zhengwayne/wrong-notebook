import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FigureCompare } from '@/components/figure-compare';
import { PrintableQuestion } from '@/components/print-preview/printable-question';
import type { PrintDisplayOptions } from '@/components/print-preview/print-options';
import { LanguageProvider } from '@/contexts/LanguageContext';
import type { PrintableErrorItem } from '@/types/api';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
const ORIGINAL = 'data:image/png;base64,AAAA';

const defaultOptions: PrintDisplayOptions = {
    showQuestionText: true,
    showAnswers: false,
    showAnalysis: false,
    showTags: false,
    showOriginalImage: true,
    imageScale: 70,
};

function item(partial: Partial<PrintableErrorItem> = {}): PrintableErrorItem {
    return {
        id: 'e1',
        shortId: 'abc123',
        questionText: '如图，$\\triangle ABC$。',
        answerText: null,
        analysis: null,
        knowledgePoints: '[]',
        originalImageUrl: ORIGINAL,
        figureSvg: SVG,
        subject: { name: '数学' },
        tags: [],
        ...partial,
    } as PrintableErrorItem;
}

describe('FigureCompare', () => {
    it('默认同时展示 AI 配图和原图，宽屏并排、窄屏堆叠', () => {
        const html = renderToStaticMarkup(
            <LanguageProvider>
                <FigureCompare svg={SVG} originalSrc={ORIGINAL} />
            </LanguageProvider>,
        );
        expect(html).toContain('data-testid="figure-compare"');
        expect(html).toContain('grid-cols-1');
        expect(html).toContain('sm:grid-cols-2');
        expect(html).toContain('print:grid-cols-2');
        expect(html).toContain('data:image/svg+xml');
        expect(html).toContain(ORIGINAL);
        expect(html).not.toContain('gradient');
    });
});

describe('打印预览的原图对照', () => {
    it('默认在配图旁打印原图，关闭选项后只保留 SVG', () => {
        const withOriginal = renderToStaticMarkup(
            <LanguageProvider>
                <PrintableQuestion item={item()} index={0} options={defaultOptions} reserveAnswerSpace={false} />
            </LanguageProvider>,
        );
        expect(withOriginal).toContain('data-testid="figure-compare"');
        expect(withOriginal).toContain(ORIGINAL);

        const withoutOriginal = renderToStaticMarkup(
            <LanguageProvider>
                <PrintableQuestion
                    item={item()}
                    index={0}
                    options={{ ...defaultOptions, showOriginalImage: false }}
                    reserveAnswerSpace={false}
                />
            </LanguageProvider>,
        );
        expect(withoutOriginal).not.toContain('data-testid="figure-compare"');
        expect(withoutOriginal).toContain('data:image/svg+xml');
        expect(withoutOriginal).not.toContain(ORIGINAL);
    });
});
