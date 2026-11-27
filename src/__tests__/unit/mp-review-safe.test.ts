/**
 * 小程序生成类文字：默认原样返回；MP_SHOW_GENERATED_TEXT=false 时经小程序令牌访问置空答案、解析、错因、参考答案；网页端请求原样返回。
 */
import { describe, expect, it } from 'vitest';
import { hideGeneratedText, isMiniProgramGeneratedTextEnabled, isMiniProgramRequest, mpSafeBody, rejectMiniProgramGeneration } from '@/lib/server/mp-review-safe';

const mpReq = () => new Request('http://localhost/x', { headers: { authorization: 'Bearer xjmp_abc123' } });
const webReq = () => new Request('http://localhost/x', { headers: { cookie: 'next-auth.session-token=1' } });

describe('mp-review-safe', () => {
    it('只认小程序 Bearer 令牌', () => {
        expect(isMiniProgramRequest(mpReq())).toBe(true);
        expect(isMiniProgramRequest(webReq())).toBe(false);
        expect(isMiniProgramRequest(new Request('http://localhost/x', { headers: { authorization: 'Bearer other' } }))).toBe(false);
        expect(isMiniProgramRequest(null)).toBe(false);
    });

    it('递归置空生成类字段，保留题目、学生作答、对错与日期', () => {
        const date = new Date('2026-11-26T00:00:00Z');
        const body = {
            items: [{ questionText: 'Q', answerText: 'A', analysis: 'X', mistakeAnalysis: null, wrongAnswerText: 'W', createdAt: date }],
            paper: { questions: [{ questionText: 'Q2', studentAnswer: 'S', correctAnswer: 'C', errorCause: 'E', verdict: 'wrong' }] },
        };
        const out = hideGeneratedText(body);
        expect(out.items[0]).toEqual({ questionText: 'Q', answerText: '', analysis: '', mistakeAnalysis: null, wrongAnswerText: 'W', createdAt: date });
        expect(out.paper.questions[0]).toEqual({ questionText: 'Q2', studentAnswer: 'S', correctAnswer: '', errorCause: '', verdict: 'wrong' });
        expect(body.items[0].answerText).toBe('A');
    });

    it('开关默认打开：小程序也原样返回；显式关闭才置空', () => {
        expect(isMiniProgramGeneratedTextEnabled({})).toBe(true);
        expect(isMiniProgramGeneratedTextEnabled({ MP_SHOW_GENERATED_TEXT: 'true' })).toBe(true);
        for (const off of ['false', '0', 'off', 'NO', ' False ']) expect(isMiniProgramGeneratedTextEnabled({ MP_SHOW_GENERATED_TEXT: off })).toBe(false);
        const body = { answerText: 'A' };
        expect(mpSafeBody(mpReq(), body, {})).toBe(body);
        expect(mpSafeBody(mpReq(), body, { MP_SHOW_GENERATED_TEXT: 'false' })).toEqual({ answerText: '' });
    });

    it('网页端请求原样返回、不拦截', () => {
        const body = { answerText: 'A' };
        const off = { MP_SHOW_GENERATED_TEXT: 'false' };
        expect(mpSafeBody(webReq(), body, off)).toBe(body);
        expect(mpSafeBody(mpReq(), body, off)).toEqual({ answerText: '' });
        expect(rejectMiniProgramGeneration(webReq())).toBeNull();
        expect(rejectMiniProgramGeneration(mpReq())?.status).toBe(403);
    });
});
