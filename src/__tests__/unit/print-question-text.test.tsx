/**
 * 打印题干：选择题选项按长度横排（Ported from margrop/wrong-notebook 346a33c4, MIT）
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PrintQuestionText } from '@/components/print-preview/print-question-text';

describe('PrintQuestionText', () => {
    it('逐行排列的短选项排成 4 列', () => {
        const html = renderToStaticMarkup(<PrintQuestionText content={'下列哪个数是质数？（ ）\nA. 4\nB. 6\nC. 7\nD. 9'} />);
        expect(html).toContain('data-columns="4"');
        expect(html).toContain('print:grid-cols-4');
        expect(html).toContain('A.');
        expect(html).toContain('下列哪个数是质数');
    });

    it('非选择题按原文渲染，不出现选项网格', () => {
        const html = renderToStaticMarkup(<PrintQuestionText content={'求解方程 x+1=2。'} />);
        expect(html).not.toContain('choice-options');
        expect(html).toContain('求解方程');
    });
});
