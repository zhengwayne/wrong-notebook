import { describe, expect, it } from 'vitest';
import { computeSubmissionBucket } from '@/lib/grading-triage';
import { parseExamPaperRead } from '@/lib/ai/exam-paper-read';

describe('Task 2.3: 红绿灯置信度分流规则 computeSubmissionBucket', () => {
    it('学号姓名高置信度匹配、无视觉预警且全为高置信度客观题时归入绿灯免检区', () => {
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'auto',
            matchConfidence: 0.98,
            visualAlertsCount: 0,
            results: [
                { type: 'objective', verdict: 'correct', confidence: 0.95 },
                { type: 'objective', verdict: 'wrong', confidence: 0.91 },
            ],
        })).toBe('green');
    });

    it('包含主观题、低置信度题目、卷头待确认或有涂改留白预警时一律归入黄灯待复核区', () => {
        // 含主观题 -> yellow
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'auto',
            matchConfidence: 0.99,
            visualAlertsCount: 0,
            results: [
                { type: 'objective', verdict: 'correct', confidence: 0.95 },
                { type: 'subjective', verdict: 'correct', confidence: 0.95 },
            ],
        })).toBe('yellow');

        // 卷头匹配度不足 -> yellow
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'auto',
            matchConfidence: 0.75,
            visualAlertsCount: 0,
            results: [{ type: 'objective', verdict: 'correct', confidence: 0.99 }],
        })).toBe('yellow');

        // 存在视觉异常预警 -> yellow
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'manual',
            matchConfidence: null,
            visualAlertsCount: 1,
            results: [{ type: 'objective', verdict: 'correct', confidence: 0.99 }],
        })).toBe('yellow');

        // 漏读/缺失或 NaN confidence -> yellow（不能免检进绿灯）
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'auto',
            matchConfidence: 0.98,
            visualAlertsCount: 0,
            results: [{ type: 'objective', verdict: 'blank', confidence: null }],
        })).toBe('yellow');

        // 含未经教师固化的 ai_inferred 标准答案 -> yellow
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'auto',
            matchConfidence: 0.98,
            visualAlertsCount: 0,
            hasUnverifiedKey: true,
            results: [{ type: 'objective', verdict: 'correct', confidence: 0.99 }],
        })).toBe('yellow');
    });

    it('parseExamPaperRead 将百分制置信度归一化为 0~1 小数并触发黄灯分流', () => {
        const read = parseExamPaperRead(JSON.stringify({
            studentName: '张三',
            questions: [{ number: '1', answer: 'B', confidence: 60 }],
        }));
        expect(read.questions[0].confidence).toBeCloseTo(0.6);
        expect(computeSubmissionBucket({
            studentId: 'stu-1',
            matchStatus: 'auto',
            matchConfidence: 0.98,
            visualAlertsCount: 0,
            results: [{ type: 'objective', verdict: 'correct', confidence: read.questions[0].confidence }],
        })).toBe('yellow');
    });
});
