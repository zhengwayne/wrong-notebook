import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    readExamPaper: vi.fn(),
    reanswerQuestion: vi.fn(),
    miniMaxState: {} as { account?: { accessToken: string; invalid?: boolean } },
}));

vi.mock('@/lib/ai', () => ({
    getAIService: vi.fn((role?: string) => (
        role === 'vision'
            ? { readExamPaper: mocks.readExamPaper }
            : { reanswerQuestion: mocks.reanswerQuestion }
    )),
}));
vi.mock('@/lib/minimax-code/store', () => ({
    readMiniMaxCodeState: vi.fn(() => mocks.miniMaxState),
}));

import { computeAiReadiness } from '@/lib/ai-readiness';
import { gradeLevelToScore, scoreRatioToGradeLevel } from '@/lib/grading-grades';
import { inferAnswerKeyFromSampleImages } from '@/lib/grading-quick-key';
import type { AppConfig } from '@/types/api';

describe('Task 2.1: AI 就绪检测、等级制评分与随堂无答案速批流水线', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('computeAiReadiness 准确识别各渠道密钥就绪状态且不泄露任何密钥内容', () => {
        const unready = computeAiReadiness({
            aiProvider: 'gemini',
            gemini: { apiKey: '' },
        } as AppConfig);
        expect(unready).toEqual({
            ready: false,
            visionReady: false,
            textReady: false,
            visionProvider: 'gemini',
        });

        const readyOpenAi = computeAiReadiness({
            aiProvider: 'openai',
            textSameAsVision: false,
            aiTextProvider: 'deepseek',
            openai: {
                activeInstanceId: 'i1',
                instances: [{ id: 'i1', name: 'Main', apiKey: 'sk-secret-123', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }],
            },
            textAi: {
                deepseek: { apiKey: 'sk-ds-456' },
            },
        } as AppConfig);
        expect(readyOpenAi).toEqual({
            ready: true,
            visionReady: true,
            textReady: true,
            visionProvider: 'openai',
        });
        expect(JSON.stringify(readyOpenAi)).not.toContain('sk-');

        // openai 缺少有效 activeInstanceId 时不回fallback instances[0]，视为未就绪
        expect(computeAiReadiness({
            aiProvider: 'openai',
            openai: {
                activeInstanceId: '',
                instances: [{ id: 'i1', name: 'Main', apiKey: 'sk-secret-123', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }],
            },
        } as AppConfig).ready).toBe(false);

        // minimax-code 未登录或 token 失效时为未就绪
        mocks.miniMaxState = {};
        expect(computeAiReadiness({ aiProvider: 'minimax-code' } as AppConfig).ready).toBe(false);
        mocks.miniMaxState = { account: { accessToken: 'tok', invalid: false } };
        expect(computeAiReadiness({ aiProvider: 'minimax-code' } as AppConfig).ready).toBe(true);
    });

    it('等级制与数值分双向折算准确且满足半分精度', () => {
        expect(scoreRatioToGradeLevel(95, 100)).toBe('excellent');
        expect(scoreRatioToGradeLevel(80, 100)).toBe('good');
        expect(scoreRatioToGradeLevel(62, 100)).toBe('pass');
        expect(scoreRatioToGradeLevel(45, 100)).toBe('needs_revision');
        expect(scoreRatioToGradeLevel(0, 0)).toBe('needs_revision');

        expect(gradeLevelToScore('excellent', 10)).toBe(10);
        expect(gradeLevelToScore('good', 10)).toBe(8.5);
        expect(gradeLevelToScore('pass', 10)).toBe(6.5);
        expect(gradeLevelToScore('needs_revision', 10)).toBe(3);
    });

    it('随堂无答案速批采用 Vision 提取题干 + Text 独立重解三段防幻觉推导参考答案', async () => {
        mocks.readExamPaper.mockResolvedValue({
            studentName: '张三',
            className: null,
            studentNo: null,
            questions: [
                {
                    number: '1',
                    type: 'objective',
                    maxScore: 4,
                    // 故意模拟 Vision 在无答案卷上误抓了学生的错误作答 '999'
                    answer: '999',
                    questionText: '解方程 $2x + 1 = 7$，则 $x =$ ____',
                    knowledgePoints: ['一元一次方程'],
                },
            ],
        });
        mocks.reanswerQuestion.mockResolvedValue({
            answerText: '3',
            analysis: '移项得 $2x=6$，故 $x=3$。',
        });

        const inferred = await inferAnswerKeyFromSampleImages(
            ['data:image/jpeg;base64,AAA'],
            '数学',
            'zh',
        );

        expect(mocks.readExamPaper).toHaveBeenCalledTimes(1);
        expect(mocks.reanswerQuestion).toHaveBeenCalledWith(
            '解方程 $2x + 1 = 7$，则 $x =$ ____',
            'zh',
            '数学',
        );
        expect(inferred).toEqual([
            {
                number: '1',
                type: 'objective',
                maxScore: 4,
                answer: '3',
                answerSource: 'ai_inferred',
                questionText: '解方程 $2x + 1 = 7$，则 $x =$ ____',
                knowledgePoints: ['一元一次方程'],
            },
        ]);
    });
});
