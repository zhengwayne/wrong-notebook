/**
 * 收卷拍照改卷：答案解析、判分、改判、汇总等纯逻辑
 */
import { describe, it, expect } from 'vitest';
import {
    applyTeacherOverride, buildScoresCsv, compareObjective, expandNumberRange, gradeAnswers,
    matchStudentByName, parseQuickAnswerKey, parseRoster, summarizeTask, type KeyQuestion,
} from '@/lib/grading';
import { parseExamPaperRead } from '@/lib/ai/exam-paper-read';
import { groupPages } from '@/lib/use-paper-images';

const q = (id: string, number: string, type: 'objective' | 'subjective', answer: string, maxScore: number, extra: Partial<KeyQuestion> = {}): KeyQuestion => ({
    id, number, type, answer, maxScore, acceptedAnswers: [], questionText: null, knowledgePoints: [], ...extra,
} as KeyQuestion);

describe('expandNumberRange', () => {
    it('展开各种区间写法', () => {
        expect(expandNumberRange('1-3')).toEqual(['1', '2', '3']);
        expect(expandNumberRange('4..5')).toEqual(['4', '5']);
        expect(expandNumberRange('6至7')).toEqual(['6', '7']);
        expect(expandNumberRange('8')).toEqual(['8']);
        expect(expandNumberRange('5-1')).toEqual(['5-1']);
    });
});

describe('parseQuickAnswerKey', () => {
    it('解析连续选择题、多选、分值、可接受答案和主观题', () => {
        const { questions, errors } = parseQuickAnswerKey('1-5 ABCDA\n6-7 AB CD\n8 B 3分\n9 x=2|x=2.0 4\n13 主观 10 列方程求解', 2);
        expect(errors).toEqual([]);
        expect(questions.map((item) => item.number)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '13']);
        expect(questions[0]).toMatchObject({ answer: 'A', maxScore: 2, type: 'objective' });
        expect(questions[5].answer).toBe('AB');
        expect(questions[7]).toMatchObject({ answer: 'B', maxScore: 3 });
        expect(questions[8].maxScore).toBe(4);
        expect([questions[8].answer, ...(questions[8].acceptedAnswers || [])]).toEqual(expect.arrayContaining(['x=2', 'x=2.0']));
        expect(questions[9]).toMatchObject({ type: 'subjective', maxScore: 10, answer: '列方程求解' });
    });

    it('返回无法识别的行号', () => {
        const { errors } = parseQuickAnswerKey('1-3 AB\n乱写\n\n4 C');
        expect(errors).toEqual([1, 2]);
    });
});

describe('compareObjective', () => {
    it('选择题不区分大小写和顺序，空答记为 blank', () => {
        expect(compareObjective('a', { answer: 'A' })).toBe('correct');
        expect(compareObjective('DB', { answer: 'BD' })).toBe('correct');
        expect(compareObjective('B', { answer: 'BD' })).toBe('wrong');
        expect(compareObjective('', { answer: 'A' })).toBe('blank');
        expect(compareObjective('x=2.0', { answer: 'x=2', acceptedAnswers: ['x=2.0'] })).toBe('correct');
    });
});

describe('gradeAnswers', () => {
    it('客观题本地比对，主观题采用 AI 分并截断到满分', () => {
        const questions = [q('k1', '1', 'objective', 'A', 2), q('k2', '2', 'objective', 'C', 2), q('k3', '3', 'subjective', '要点', 10)];
        const results = gradeAnswers(questions, [
            { number: '1', answer: 'A' }, { number: '2', answer: 'B' }, { number: '3', answer: '过程', score: 12.3, reason: '步骤完整' },
        ]);
        expect(results.map((result) => [result.verdict, result.score, result.source])).toEqual([
            ['correct', 2, 'auto'], ['wrong', 0, 'auto'], ['correct', 10, 'ai'],
        ]);
        expect(results[2].reason).toBe('步骤完整');
    });

    it('缺题记为 blank、0 分', () => {
        const [result] = gradeAnswers([q('k1', '1', 'subjective', '', 5)], []);
        expect(result).toMatchObject({ verdict: 'blank', score: 0, aiScore: null });
    });
});

describe('applyTeacherOverride', () => {
    it('一键判对/判错/改分', () => {
        expect(applyTeacherOverride(5, { verdict: 'correct' })).toEqual({ verdict: 'correct', score: 5, source: 'teacher' });
        expect(applyTeacherOverride(5, { verdict: 'wrong' })).toEqual({ verdict: 'wrong', score: 0, source: 'teacher' });
        expect(applyTeacherOverride(5, { score: 3.2 })).toMatchObject({ verdict: 'partial', score: 3 });
        expect(applyTeacherOverride(5, { score: 99 })).toMatchObject({ verdict: 'correct', score: 5 });
    });
});

describe('matchStudentByName / parseRoster', () => {
    const roster = [{ id: 's1', name: '张三' }, { id: 's2', name: '李四' }, { id: 's3', name: '张三丰' }];
    it('精确匹配优先，唯一模糊匹配次之', () => {
        expect(matchStudentByName('张 三', roster)).toBe('s1');
        expect(matchStudentByName('李四同学', roster)).toBe('s2');
        expect(matchStudentByName('王五', roster)).toBeNull();
        expect(matchStudentByName(null, roster)).toBeNull();
    });
    it('花名册按多种分隔符拆分并去重', () => {
        expect(parseRoster('张三，李四、王五\n张三')).toEqual(['张三', '李四', '王五']);
    });
});

describe('summarizeTask / buildScoresCsv', () => {
    const questions = [q('k1', '1', 'objective', 'A', 2, { knowledgePoints: ['方程'] }), q('k2', '2', 'objective', 'B', 3, { knowledgePoints: ['函数'] })];
    const submissions = [
        { id: 'p1', studentName: '张三', status: 'graded', totalScore: 5, results: [{ keyQuestionId: 'k1', verdict: 'correct', score: 2 }, { keyQuestionId: 'k2', verdict: 'correct', score: 3 }] },
        { id: 'p2', studentName: '=李四', status: 'confirmed', totalScore: 2, results: [{ keyQuestionId: 'k1', verdict: 'correct', score: 2 }, { keyQuestionId: 'k2', verdict: 'wrong', score: 0 }] },
        { id: 'p3', studentName: null, status: 'pending', totalScore: null, results: [] },
    ];

    it('统计平均分、错误率与薄弱知识点', () => {
        const summary = summarizeTask({ questions, submissions });
        expect(summary).toMatchObject({ fullScore: 5, gradedCount: 2, averageScore: 3.5, highestScore: 5, lowestScore: 2 });
        expect(summary.questions[1]).toMatchObject({ wrong: 1, errorRate: 50 });
        expect(summary.weakPoints).toEqual([{ name: '函数', wrong: 1, total: 2, errorRate: 50 }]);
        expect(summary.students[1].wrongNumbers).toEqual(['2']);
    });

    it('CSV 带 BOM 并防公式注入', () => {
        const csv = buildScoresCsv({ questions, submissions }, { name: '姓名', total: '总分' });
        expect(csv.startsWith('\uFEFF姓名,总分,1,2')).toBe(true);
        expect(csv).toContain("'=李四,2,2,0");
    });
});

describe('parseExamPaperRead', () => {
    it('解析 AI 读卷 JSON，过滤空姓名', () => {
        const result = parseExamPaperRead('```json\n{"studentName":"无","questions":[{"number":1,"answer":"A"}]}\n```');
        expect(result.studentName).toBeNull();
        expect(result.questions[0]).toMatchObject({ number: '1', answer: 'A' });
    });
});

describe('groupPages', () => {
    it('按每份页数分组', () => {
        expect(groupPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(groupPages([1, 2], 1)).toEqual([[1], [2]]);
    });
});
