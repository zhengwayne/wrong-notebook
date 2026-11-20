import { describe, expect, it } from 'vitest';
import { normalizeAiQuestionTags } from '@/lib/ai/knowledge-points';
import { generateAnalyzePrompt } from '@/lib/ai/prompts';

describe('AI 知识点候选集合校验', () => {
    it('过滤自创、翻译及其他学科标签，并去重和清理空白', () => {
        expect(normalizeAiQuestionTags({ subject: '数学', knowledgePoints: [' 加法 ', '自创标签', 'Addition', '加法', '力学'] }, { candidateTags: { subjectName: '数学', tags: ['加法'] } }).knowledgePoints).toEqual(['加法']);
    });
    it('空候选集合保持空结果，不退回自由造标签', () => {
        expect(normalizeAiQuestionTags({ knowledgePoints: ['自创'] }, { candidateTags: { subjectName: '数学', tags: [] } }).knowledgePoints).toEqual([]);
    });
    it('未指定错题本时，按实际识别的学科选择预取清单', () => {
        expect(normalizeAiQuestionTags({ subject: '物理', knowledgePoints: ['加法', '力学'] }, { prefetchedMathTags: ['加法'], prefetchedPhysicsTags: ['力学'] }).knowledgePoints).toEqual(['力学']);
    });
    it('即使没有提供候选集合，AI 标签也最多五个且不重复', () => {
        expect(normalizeAiQuestionTags({ knowledgePoints: ['1', '1', '2', '3', '4', '5', '6'] }, {}).knowledgePoints).toEqual(['1', '2', '3', '4', '5']);
    });

    it.each([
        ['数学', 'prefetchedMathTags', '勾股定理'],
        ['物理', 'prefetchedPhysicsTags', '牛顿第一定律'],
        ['化学', 'prefetchedChemistryTags', '质量守恒定律'],
        ['生物', 'prefetchedBiologyTags', '光合作用'],
        ['英语', 'prefetchedEnglishTags', '一般现在时'],
        ['语文', 'prefetchedChineseTags', '文言虚词'],
        ['历史', 'prefetchedHistoryTags', '洋务运动'],
        ['地理', 'prefetchedGeographyTags', '季风气候'],
        ['政治', 'prefetchedPoliticsTags', '公民基本权利'],
    ] as const)('覆盖全部 9 科（%s）预取标签过滤与提示词输出不为空', (subject, field, tagName) => {
        const options = { [field]: [tagName] };
        expect(normalizeAiQuestionTags({ subject, knowledgePoints: [tagName, '不存在的标签'] }, options).knowledgePoints).toEqual([tagName]);

        const prompt = generateAnalyzePrompt('zh', 8, subject, options);
        expect(prompt).toContain(`"${tagName}"`);
    });
});
