/**
 * 小程序新手引导：身份选择、按钮去向、界面文字（审核安全）与老师收卷进度。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/request', () => ({ request: vi.fn() }));

import {
    buildGuideView, GUIDE_COPY, guideAction, guidePersonaFor, latestCollect, type GuideStatus,
} from '../src/utils/onboarding';

function status(persona: GuideStatus['persona'], done: boolean[], metas: Record<string, Record<string, string | number | null>> = {}): GuideStatus {
    const keys = Object.keys(GUIDE_COPY[persona].steps);
    const steps = keys.map((key, i) => ({ key, done: done[i] ?? false, meta: metas[key] }));
    const doneCount = steps.filter((s) => s.done).length;
    return {
        persona, steps, doneCount, total: steps.length, completed: doneCount === steps.length,
        completedAt: null, dismissedAt: null, visible: true, current: steps.find((s) => !s.done)?.key ?? null,
    };
}

describe('新手引导', () => {
    it('按当前身份选引导，没有就用第一个身份', () => {
        expect(guidePersonaFor({ personas: ['parent', 'teacher'], activePersona: 'teacher' })).toBe('teacher');
        expect(guidePersonaFor({ personas: ['parent'], activePersona: null })).toBe('parent');
        expect(guidePersonaFor({ personas: [], activePersona: null })).toBe('self');
    });

    it('老师的步骤都交给网页端，路径在一次性链接白名单内', () => {
        const s = status('teacher', [true, true, true, false], { task: { taskId: 't_1', title: '期中' }, collect: { count: 3, taskId: 't_1' } });
        expect(guideAction(s, 'class')).toEqual({ kind: 'web', path: '/grading' });
        expect(guideAction(s, 'collect')).toEqual({ kind: 'web', path: '/grading/t_1' });
        expect(guideAction(s, 'confirm')).toEqual({ kind: 'web', path: '/grading/t_1/papers' });
        expect(guideAction(s, 'finish')).toEqual({ kind: 'web', path: '/teacher' });
        const view = buildGuideView(s);
        expect(view.steps[3]).toMatchObject({ current: true, button: '在电脑上做', web: true });
        expect(view.steps[2].note).toBe('3 份答卷');
    });

    it('家长与自学在小程序里直接去做', () => {
        const p = status('parent', [true, true, false], { confirm: { paperId: 'pp1', count: 0 } });
        expect(guideAction(p, 'child')).toEqual({ kind: 'page', target: 'me' });
        expect(guideAction(p, 'confirm')).toEqual({ kind: 'page', target: 'grade', id: 'pp1' });
        expect(guideAction(status('parent', []), 'confirm')).toEqual({ kind: 'page', target: 'capture' });
        expect(guideAction(status('self', []), 'collect')).toEqual({ kind: 'page', target: 'capture' });
        expect(guideAction(status('self', []), 'review')).toEqual({ kind: 'page', target: 'review' });
    });

    it('全部完成后显示“已经上手了”', () => {
        const view = buildGuideView(status('self', [true, true, true]));
        expect(view.title).toBe('已经上手了');
        expect(view.percent).toBe(100);
    });

    it('引导文字不出现 AI / 生成字样', () => {
        const text = JSON.stringify(GUIDE_COPY);
        expect(text).not.toMatch(/(?<![A-Za-z])AI(?![A-Za-z_])|智能|生成|大模型|模型/);
    });

    it('收卷进度取最近一次改卷', () => {
        expect(latestCollect([])).toBeNull();
        expect(latestCollect([
            { id: 'a', name: '一班', studentCount: 40, latestTask: { id: 't1', title: '旧', createdAt: '2026-11-01T00:00:00.000Z', studentCount: 40, submissionCount: 40, confirmedCount: 40 } },
            { id: 'b', name: '二班', studentCount: 42, latestTask: { id: 't2', title: '第三单元', createdAt: '2026-11-20T00:00:00.000Z', studentCount: 42, submissionCount: 3, confirmedCount: 1 } },
            { id: 'c', name: '三班', studentCount: 0, latestTask: null },
        ])).toEqual({ title: '第三单元', className: '二班', submitted: 3, total: 42, confirmed: 1 });
    });
});
