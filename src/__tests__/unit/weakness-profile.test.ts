import { describe, expect, it } from 'vitest';
import { buildClassWeaknesses, buildWeaknessProfile, selectPracticeSlots, type ProfileItem } from '@/lib/variant/weakness-profile';

const now = new Date('2026-11-13T00:00:00+08:00');

function item(partial: Partial<ProfileItem> & { id: string; knowledgePoints: string[] }): ProfileItem {
    return {
        createdAt: '2026-11-01T00:00:00+08:00',
        practiceCount: 0,
        masteryProbability: null,
        ...partial,
    };
}

describe('buildWeaknessProfile', () => {
    it('把近期、未掌握、多次做错的知识点排在前面', () => {
        const profile = buildWeaknessProfile([
            item({ id: 'a', knowledgePoints: ['有理数'], createdAt: '2026-11-12T00:00:00+08:00', practiceCount: 0, errorType: '计算' }),
            item({ id: 'b', knowledgePoints: ['有理数'], createdAt: '2026-10-01T00:00:00+08:00', practiceCount: 3, wrongPracticeCount: 2, masteryProbability: 0.2, errorType: '计算' }),
            item({ id: 'c', knowledgePoints: ['方程'], createdAt: '2026-01-01T00:00:00+08:00', practiceCount: 4, masteryProbability: 0.9, errorType: '概念' }),
        ], { now, masteryThreshold: 50 });
        expect(profile.weaknesses[0].knowledgePoint).toBe('有理数');
        expect(profile.weaknesses[0].unmasteredCount).toBe(2);
        expect(profile.weaknesses[0].score).toBeGreaterThan(profile.weaknesses[1].score);
        expect(profile.suggestedDifficulty).toBe('medium');
        expect(profile.errorTypeSummary['计算']).toBe(2);
    });

    it('已掌握的旧题权重低', () => {
        const profile = buildWeaknessProfile([
            item({ id: 'c', knowledgePoints: ['方程'], createdAt: '2025-01-01T00:00:00+08:00', practiceCount: 5, masteryProbability: 0.95 }),
        ], { now });
        expect(profile.suggestedDifficulty).toBe('harder');
        expect(profile.weaknesses[0].unmasteredCount).toBe(0);
    });
});

describe('selectPracticeSlots', () => {
    it('按弱点分配题目并由易到难递进', () => {
        const items = [
            item({ id: 'a', knowledgePoints: ['有理数'] }),
            item({ id: 'b', knowledgePoints: ['方程'] }),
        ];
        const profile = buildWeaknessProfile(items, { now });
        const slots = selectPracticeSlots(profile, items, 4, { startDifficulty: 'easy' });
        expect(slots).toHaveLength(4);
        expect(slots[0].difficulty).toBe('easy');
        expect(slots[slots.length - 1].difficulty).toBe('harder');
        expect(slots.map((slot) => slot.knowledgePoint)).toContain('有理数');
        expect(new Set(slots.map((slot) => slot.sourceItemId)).size).toBeGreaterThan(1);
    });
});

describe('buildClassWeaknesses', () => {
    it('汇总多名学生都薄弱的知识点', () => {
        const alice = buildWeaknessProfile([item({ id: '1', knowledgePoints: ['有理数'] }), item({ id: '2', knowledgePoints: ['方程'] })], { now });
        const bob = buildWeaknessProfile([item({ id: '3', knowledgePoints: ['有理数'] })], { now });
        const common = buildClassWeaknesses([{ studentKey: 'alice', profile: alice }, { studentKey: 'bob', profile: bob }]);
        expect(common[0].knowledgePoint).toBe('有理数');
        expect(common[0].studentCount).toBe(2);
        expect(common.find((item) => item.knowledgePoint === '方程')).toBeUndefined();
    });
});
