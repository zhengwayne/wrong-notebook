import { describe, expect, it } from 'vitest';
import { deriveErrorType } from '@/lib/error-type';
import { groupErrorItems } from '@/lib/error-list-groups';
import { attachSourceQuestions } from '@/lib/learning-path/service';
import { getReviewPlan, isReviewDue } from '@/lib/review-schedule';

describe('错题与复习、学习路径的关联', () => {
    it('新录入的错题当天即可进入复习队列', () => {
        const created = new Date('2026-11-16T10:49:00+08:00');
        const plan = getReviewPlan(created, [], 'Asia/Taipei');
        expect(plan.stage).toBe(0);
        expect(isReviewDue(plan, 'Asia/Taipei', new Date('2026-11-16T18:50:00+08:00'))).toBe(true);
        expect(isReviewDue(plan, 'Asia/Taipei', new Date('2026-11-15T18:50:00+08:00'))).toBe(false);
    });

    it('路径步骤带上对应错题的题干、错解和错因', () => {
        const path = attachSourceQuestions({
            steps: [{ errorItemIds: ['a', 'b'], title: '复习有余数的除法' }],
            today: [{ errorItemIds: ['a'] }],
        }, [
            { id: 'a', shortId: '9sgw8n', questionText: '540÷90', wrongAnswerText: '5', mistakeAnalysis: '商写成了 5', tags: [{ name: '简单除法竖式' }] },
            { id: 'b', shortId: 'other', questionText: '求商和余数', wrongAnswerText: '商 40 余 4', mistakeAnalysis: '商余写反', knowledgePoints: '["有余数的除法"]' },
        ]);
        expect(path.today[0].sourceQuestions).toHaveLength(1);
        expect(path.today[0].sourceQuestions[0].wrongAnswerText).toBe('5');
        expect(path.steps[0].sourceQuestions.map((item) => item.shortId)).toEqual(['9sgw8n', 'other']);
        expect(path.steps[0].sourceQuestions[1].knowledgePoints).toEqual(['有余数的除法']);
    });

    it('可按知识点和错因分组', () => {
        const items = [
            { id: '1', errorType: '商余写反', tags: [{ name: '有余数的除法' }], createdAt: '2026-11-16' },
            { id: '2', mistakeAnalysis: '把 540÷90 的商写成了 5。', tags: [{ name: '简单除法竖式' }, { name: '有余数的除法' }], createdAt: '2026-11-16' },
        ];
        const byKp = groupErrorItems(items, 'knowledge', { ungrouped: '未分组', unknownCause: '未标注' });
        expect(byKp.find((group) => group.key === 'kp:有余数的除法')?.items.map((item) => item.id)).toEqual(['1', '2']);
        const byCause = groupErrorItems(items, 'cause', { ungrouped: '未分组', unknownCause: '未标注' });
        expect(byCause.map((group) => group.label)).toEqual(expect.arrayContaining(['商余写反', '把 540÷90 的商写成了 5']));
    });

    it('从错因分析抽取简短分类', () => {
        expect(deriveErrorType('把商和余数写反了。后面还有补充。')).toBe('把商和余数写反了');
        expect(deriveErrorType('')).toBeNull();
    });
});
