import { describe, expect, it } from 'vitest';
import { plausibleSubjectsForGrade } from '@/lib/ai/tag-service';

describe('plausibleSubjectsForGrade', () => {
    it('小学只保留数学、语文、英语', () => {
        expect(plausibleSubjectsForGrade(4)).toEqual(['math', 'chinese', 'english']);
        expect(plausibleSubjectsForGrade(1)).toEqual(['math', 'chinese', 'english']);
    });

    it('未设年级或初高中纳入全部 9 科（含理化生与政史地）', () => {
        const expected = ['math', 'chinese', 'english', 'physics', 'chemistry', 'biology', 'history', 'geography', 'politics'];
        expect(plausibleSubjectsForGrade(null)).toEqual(expected);
        expect(plausibleSubjectsForGrade(undefined)).toEqual(expected);
        const junior = plausibleSubjectsForGrade(7);
        expect(junior).toEqual(expected);
        expect(plausibleSubjectsForGrade(11)).toEqual(junior);
    });
});
