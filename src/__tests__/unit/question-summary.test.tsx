/**
 * 错题卡片题干摘要：文字去掉 Markdown 格式，公式交给 KaTeX 渲染
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn() } }));

import { QuestionSummary } from '@/components/error-list/question-summary';
import { buildQuestionSummary } from '@/lib/question-summary';

describe('buildQuestionSummary', () => {
    it('空内容返回空数组', () => {
        expect(buildQuestionSummary('', 80)).toEqual([]);
        expect(buildQuestionSummary(null, 80)).toEqual([]);
    });

    it('拆分文字与公式，并去掉 Markdown 格式', () => {
        expect(buildQuestionSummary('**已知** $\\frac{\\sqrt{3}}{2}$，求 $\\sin\\alpha$ 的值', 80)).toEqual([
            { type: 'text', value: '已知 ' },
            { type: 'math', tex: '\\frac{\\sqrt{3}}{2}' },
            { type: 'text', value: '，求 ' },
            { type: 'math', tex: '\\sin\\alpha' },
            { type: 'text', value: ' 的值' },
        ]);
    });

    it('统一 \\(…\\)、$$…$$ 定界符，且块公式内的空行不会被当作分段', () => {
        expect(buildQuestionSummary('计算 \\(a+b\\)：$$x=\n\n1$$\n\n第二段', 80)).toEqual([
            { type: 'text', value: '计算 ' },
            { type: 'math', tex: 'a+b' },
            { type: 'text', value: '：' },
            { type: 'math', tex: 'x=\n\n1' },
        ]);
    });

    it('只取第一段', () => {
        expect(buildQuestionSummary('第一段\n\n第二段', 80)).toEqual([{ type: 'text', value: '第一段' }]);
    });

    it('超长时截断文字并加省略号，公式不会被截断到一半', () => {
        expect(buildQuestionSummary('一二三四五六', 4)).toEqual([{ type: 'text', value: '一二三四...' }]);
        expect(buildQuestionSummary('一二三 $\\frac{1}{2}$ 四五', 4)).toEqual([
            { type: 'text', value: '一二三...' },
        ]);
        expect(buildQuestionSummary('$\\frac{1}{2}$ 一二三四五', 4)).toEqual([
            { type: 'math', tex: '\\frac{1}{2}' },
            { type: 'text', value: '...' },
        ]);
    });
});

describe('QuestionSummary', () => {
    it('用与详情页相同的渲染器显示公式，不露出 LaTeX 源码', () => {
        const html = renderToStaticMarkup(<QuestionSummary text={'已知 $\\vec{a}=\\frac{1}{2}$'} />);
        const visible = html
            .replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, '')
            .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
            .replace(/<[^>]+>/g, '');
        expect(html).toContain('class="katex"');
        expect(visible).toContain('已知');
        expect(visible).not.toContain('\\vec');
        expect(html).toContain('-webkit-line-clamp:3');
    });

    it('渲染 <u> 下划线，并把 **加粗** 显示为粗体而不是星号', () => {
        const html = renderToStaticMarkup(
            <QuestionSummary text={'Look at the l<u>ea</u>ves. **数量关系混淆** $1200 \\div 50$'} clamp={2} />,
        );
        expect(html).toMatch(/<u>ea<\/u>/);
        expect(html).toContain('<strong');
        expect(html).not.toContain('**数量关系混淆**');
        expect(html).toContain('class="katex"');
        expect(html).not.toContain('$1200');
        expect(html).toContain('-webkit-line-clamp:2');
    });
});
