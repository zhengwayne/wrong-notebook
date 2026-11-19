/**
 * 语文拼音与填空转写规则（Ported from margrop/wrong-notebook 8386537b, MIT）
 */
import { describe, expect, it } from 'vitest';
import { generateAnalyzePrompt, generateChineseTranscriptionRules, generateExamPaperReadPrompt } from '@/lib/ai/prompts';

const keyPhrases = ['拼音必须带声调符号原样转写', '不得用数字声调', '每个空用「（  ）」原样保留', '田字格位置按原样保留为空', '带拼音注音的汉字'];

describe('语文题干转写规则', () => {
    it('语文学科的识别提示词包含拼音、填空与注音规则', () => {
        const prompt = generateAnalyzePrompt('zh', null, '语文');
        for (const phrase of keyPhrases) expect(prompt).toContain(phrase);
    });

    it('学科未知（未指定错题本）时识别提示词也包含规则', () => {
        const prompt = generateAnalyzePrompt('zh', null, null);
        for (const phrase of keyPhrases) expect(prompt).toContain(phrase);
    });

    it('数学等其他学科的识别提示词不带这些规则', () => {
        expect(generateAnalyzePrompt('zh', null, '数学')).not.toContain('【语文题干转写规则】');
    });

    it('家长批改语文试卷时附带规则，数学试卷不带', () => {
        expect(generateExamPaperReadPrompt('parent_review', 'zh', '语文')).toContain('【语文题干转写规则】');
        expect(generateExamPaperReadPrompt('parent_review', 'zh', '数学')).not.toContain('【语文题干转写规则】');
    });

    it('样例文字含拼音时附带规则', () => {
        expect(generateChineseTranscriptionRules('数学', '看拼音写词语：zhāo（朝）')).toContain('不得用数字声调');
        expect(generateChineseTranscriptionRules('数学', '计算 1+1')).toBe('');
        expect(generateChineseTranscriptionRules('chinese')).toContain('【语文题干转写规则】');
    });
});
