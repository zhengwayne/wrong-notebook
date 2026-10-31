/**
 * 收卷拍照的页自动分组：续页、同一学生连拍、首页无名、手动拆分/合并、定稿
 */
import { describe, it, expect } from 'vitest';
import { groupCapturedPages, type CapturedPage } from '@/lib/page-grouping';

const named = (id: string, name: string, studentId: string | null = null): CapturedPage => ({
    id, status: 'read', identity: { name },
    match: studentId ? { status: 'matched', studentId, confidence: 0.9, reason: 'name', candidates: [] } : { status: 'review', studentId: null, confidence: 0.4, reason: 'not_found', candidates: [] },
});
const blank = (id: string): CapturedPage => ({ id, status: 'read', identity: {} });
const reading = (id: string): CapturedPage => ({ id, status: 'reading' });

describe('groupCapturedPages', () => {
    it('没名字的页接在上一份后面，新名字开始新一份', () => {
        const papers = groupCapturedPages([named('p1', '张三', 's1'), blank('p2'), named('p3', '李四', 's2'), blank('p4')]);
        expect(papers.map((paper) => paper.pageIds)).toEqual([['p1', 'p2'], ['p3', 'p4']]);
        expect(papers.map((paper) => paper.studentId)).toEqual(['s1', 's2']);
        expect(papers.map((paper) => paper.settled)).toEqual([true, false]);
    });

    it('点完成后最后一份也定稿', () => {
        const papers = groupCapturedPages([named('p1', '张三', 's1'), blank('p2')], true);
        expect(papers[0].settled).toBe(true);
    });

    it('同一学生连续两页都写了名字时合为一份', () => {
        const papers = groupCapturedPages([named('p1', '张三', 's1'), named('p2', '张 三', 's1'), named('p3', '李四', 's2')]);
        expect(papers.map((paper) => paper.pageIds)).toEqual([['p1', 'p2'], ['p3']]);
    });

    it('未匹配名册时按卷面信息判断是否同一人', () => {
        const papers = groupCapturedPages([named('p1', '欧阳'), named('p2', '欧阳'), named('p3', '司马')]);
        expect(papers.map((paper) => paper.pageIds)).toEqual([['p1', 'p2'], ['p3']]);
        expect(papers[0].flags).toContain('needs_review');
    });

    it('第一页没有名字：单独一份并待确认；老师并入后整份采用后一页的身份', () => {
        const papers = groupCapturedPages([blank('p1'), named('p2', '张三', 's1')], true);
        expect(papers.map((paper) => paper.pageIds)).toEqual([['p1'], ['p2']]);
        expect(papers[0].flags).toEqual(expect.arrayContaining(['no_identity', 'needs_review']));
        const [merged] = groupCapturedPages([blank('p1'), { ...named('p2', '张三', 's1'), manualBreak: 'continue' }], true);
        expect(merged).toMatchObject({ pageIds: ['p1', 'p2'], studentId: 's1' });
        const [lonely] = groupCapturedPages([blank('p1'), blank('p2')], true);
        expect(lonely.flags).toEqual(expect.arrayContaining(['no_identity', 'needs_review']));
    });

    it('识别中的页暂不定稿，也挡住后面的份', () => {
        const papers = groupCapturedPages([named('p1', '张三', 's1'), reading('p2'), named('p3', '李四', 's2'), named('p4', '王五', 's3')]);
        expect(papers.map((paper) => paper.pageIds)).toEqual([['p1', 'p2'], ['p3'], ['p4']]);
        expect(papers.map((paper) => paper.settled)).toEqual([false, false, false]);
    });

    it('识别失败的页按续页处理并标记', () => {
        const papers = groupCapturedPages([named('p1', '张三', 's1'), { id: 'p2', status: 'failed' }], true);
        expect(papers[0].pageIds).toEqual(['p1', 'p2']);
        expect(papers[0].flags).toContain('read_failed');
    });

    it('老师手动拆分、合并、指定学生', () => {
        const pages = [named('p1', '张三', 's1'), { ...blank('p2'), manualBreak: 'new' as const }, { ...named('p3', '李四', 's2'), manualBreak: 'continue' as const }];
        const papers = groupCapturedPages(pages, true);
        expect(papers.map((paper) => paper.pageIds)).toEqual([['p1'], ['p2', 'p3']]);
        const assigned = groupCapturedPages([{ ...blank('p1'), assignStudentId: 's9' }], true);
        expect(assigned[0]).toMatchObject({ studentId: 's9', manual: true, flags: [] });
    });
});
