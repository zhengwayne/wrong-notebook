/**
 * 朗读前把 Markdown、LaTeX 和常见数学符号转成可说的中文或英文
 */
import { describe, expect, it } from 'vitest';
import { detectSpeechLanguage, toSpeakableText } from '@/lib/speakable-text';

describe('可朗读文本', () => {
    it('把除号、乘号和分数读成中文', () => {
        expect(toSpeakableText('计算 $540\\div 90$', 'zh')).toContain('除以');
        expect(toSpeakableText('计算 $540\\div 90$', 'zh')).toContain('540');
        expect(toSpeakableText('\\frac{1}{2}', 'zh')).toContain('2 分之 1');
        expect(toSpeakableText('3 × 4 ÷ 2', 'zh')).toMatch(/乘以/);
        expect(toSpeakableText('3 × 4 ÷ 2', 'zh')).toMatch(/除以/);
        expect(toSpeakableText('$x^2$', 'zh')).toContain('平方');
    });

    it('英文模式下用英语读运算符号', () => {
        expect(toSpeakableText(String.raw`$12 \div 3$`, 'en')).toMatch(/divided by/);
        expect(toSpeakableText(String.raw`\frac{1}{2}`, 'en')).toMatch(/1 over 2/);
    });

    it('去掉 Markdown 标题、加粗和链接，保留正文', () => {
        const spoken = toSpeakableText('## 解析\n这是**重要**的[步骤](http://example.com)。', 'zh');
        expect(spoken).toContain('解析');
        expect(spoken).toContain('重要');
        expect(spoken).toContain('步骤');
        expect(spoken).not.toContain('http');
        expect(spoken).not.toContain('**');
        expect(spoken).not.toContain('##');
    });

    it('汉字为主的题干判定为中文，纯英文句子判定为英语', () => {
        expect(detectSpeechLanguage('把 540 除以 90，再算出余数。')).toBe('zh');
        expect(detectSpeechLanguage('Listen carefully and choose the best answer for each question.')).toBe('en');
    });
});
