import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/contexts/LanguageContext';
import { MultiQuestionConfirm } from '@/components/multi-question-confirm';
import type { ParsedQuestion } from '@/lib/ai/types';

vi.mock('@/lib/frontend-logger', () => ({ frontendLogger: { error: vi.fn(), info: vi.fn() } }));

function question(partial: Partial<ParsedQuestion> & Pick<ParsedQuestion, 'questionText'>): ParsedQuestion {
    return {
        answerText: 'F',
        analysis: '解析',
        wrongAnswerText: '',
        mistakeAnalysis: '',
        mistakeStatus: 'wrong_attempt',
        subject: '英语',
        knowledgePoints: ['字母发音'],
        requiresImage: false,
        ...partial,
    };
}

describe('MultiQuestionConfirm 预览', () => {
    it('用 Markdown 渲染公式和下划线，不把源码或截断的公式露出来', () => {
        const items = [
            question({
                questionText: '以点 $O$ 为圆心。The birds fl<u>y</u> high.',
                wrongAnswerText: '半径写成了 $r$',
                mistakeAnalysis: '1. **数量关系混淆**：题目中的 $1200 \\div 50 = 24\\text{ 千克}$ 是总数。',
            }),
        ];
        const html = renderToStaticMarkup(
            <LanguageProvider>
                <MultiQuestionConfirm items={items} onCancel={() => undefined} onSave={() => undefined} />
            </LanguageProvider>,
        );
        const visible = html
            .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
            .replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, '');
        expect(html).toContain('class="katex"');
        expect(html).toMatch(/<u[^>]*>y<\/u>/);
        expect(html).toContain('<strong');
        expect(visible).not.toContain('$O$');
        expect(visible).not.toContain('$1200');
        expect(visible).not.toContain('24\\te');
        expect(visible).not.toContain('\\text{ 千克}');
        expect(visible).not.toContain('**数量关系混淆**');
        expect(html).toContain('-webkit-line-clamp');
    });
});
