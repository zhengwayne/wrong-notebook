import { describe, expect, it } from 'vitest';
import { plausibleSubjectsForGrade } from '@/lib/ai/tag-service';

describe('plausibleSubjectsForGrade', () => {
    it('小学只保留数学、语文、英语', () => {
        expect(plausibleSubjectsForGrade(4)).toEqual(['math', 'chinese', 'english']);
        expect(plausibleSubjectsForGrade(1)).toEqual(['math', 'chinese', 'english']);
        expect(plausibleSubjectsForGrade(null)).toEqual(['math', 'chinese', 'english']);
    });

    it('初高中纳入理化生与政史地', () => {
        const junior = plausibleSubjectsForGrade(7);
        expect(junior).toEqual(expect.arrayContaining(['math', 'chinese', 'english', 'physics', 'chemistry', 'biology', 'history']));
        expect(plausibleSubjectsForGrade(11)).toEqual(junior);
    });
});
