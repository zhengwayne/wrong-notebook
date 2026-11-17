import { describe, expect, it } from 'vitest';
import {
    aggregateClassCollection,
    frequentErrorCauses,
    knowledgeErrorRatesFromResults,
    personalSubjectIds,
    practiceTrendFromRecords,
} from '@/lib/home-aggregates';
import { isStudentNotebook } from '@/lib/variant/notebooks';

describe('teacher/parent home aggregates', () => {
    it('summarizes collection status per class from the latest task', () => {
        const classes = [
            { id: 'c1', name: '一班', studentCount: 40 },
            { id: 'c2', name: '二班', studentCount: 38 },
        ];
        const result = aggregateClassCollection(classes, [
            {
                id: 't-old', title: '月考', subjectName: '数学', createdAt: '2026-10-01T00:00:00.000Z',
                classId: 'c1', studentCount: 40, submissionCount: 10, confirmedCount: 8,
            },
            {
                id: 't-new', title: '期中', subjectName: '数学', createdAt: '2026-11-01T00:00:00.000Z',
                classId: 'c1', studentCount: 40, submissionCount: 36, confirmedCount: 30,
            },
        ]);
        expect(result[0].latestTask?.title).toBe('期中');
        expect(result[0].latestTask?.submissionCount).toBe(36);
        expect(result[0].latestTask?.confirmedCount).toBe(30);
        expect(result[0].taskCount).toBe(2);
        expect(result[1].latestTask).toBeNull();
        expect(result[1].studentCount).toBe(38);
    });

    it('computes knowledge-point error rates only from the given class results', () => {
        const rates = knowledgeErrorRatesFromResults([
            { knowledgePoints: ['方程'], verdict: 'wrong', studentId: 's1' },
            { knowledgePoints: ['方程'], verdict: 'correct', studentId: 's2' },
            { knowledgePoints: ['计算'], verdict: 'correct', studentId: 's1' },
        ]);
        expect(rates.map((item) => item.knowledgePoint)).toEqual(['方程']);
        expect(rates[0].errorRate).toBe(50);
        expect(rates[0].wrong).toBe(1);
        expect(rates[0].answered).toBe(2);
        expect(rates[0].studentCount).toBe(2);
    });

    it('ranks frequent error causes without mixing unlabeled and named causes', () => {
        const causes = frequentErrorCauses([
            { errorType: '计算', studentKey: 's1' },
            { errorType: '计算', studentKey: 's2' },
            { errorType: '  ', studentKey: 's1' },
            { errorType: null, studentKey: 's3' },
        ]);
        expect(causes[0]).toMatchObject({ cause: '计算', count: 2, studentCount: 2 });
        expect(causes[1]).toMatchObject({ cause: '未标注', count: 2, studentCount: 2 });
    });

    it('builds a practice trend that only includes the provided records', () => {
        const now = new Date('2026-11-17T04:00:00.000Z'); // 12:00 in Asia/Taipei
        const days = practiceTrendFromRecords([
            { createdAt: '2026-11-17T02:00:00.000Z', result: 'correct' },
            { createdAt: '2026-11-17T03:00:00.000Z', result: 'wrong' },
            { createdAt: '2026-11-16T04:00:00.000Z', isCorrect: true },
            { createdAt: '2026-10-01T00:00:00.000Z', result: 'correct' },
        ], { days: 3, timeZone: 'Asia/Taipei', now });
        expect(days).toHaveLength(3);
        expect(days[2]).toMatchObject({ date: '2026-11-17', attempted: 2, correct: 1 });
        expect(days[1]).toMatchObject({ date: '2026-11-16', attempted: 1, correct: 1 });
        expect(days[0].attempted).toBe(0);
    });

    it('excludes student notebooks from a teacher\'s personal subject list', () => {
        const ids = personalSubjectIds(
            [
                { id: 'self', name: '数学' },
                { id: 'stu', name: '李四·数学' },
            ],
            ['李四'],
            isStudentNotebook,
        );
        expect(ids).toEqual(['self']);
    });
});
