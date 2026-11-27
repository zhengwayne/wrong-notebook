import { describe, expect, it } from 'vitest';
import { figureDataUrl, markPaperChanged, metaLine, percent, safeImage, stars, takePaperChanged, toHistory, toPlan, utf8ToBase64 } from '../src/utils/detail';

describe('错题详情：纯逻辑', () => {
  it('做题记录：只显示有结果的，带来源', () => {
    const rows = toHistory([
      { id: 'a', result: 'correct', source: 'manual', createdAt: '2026-11-20T08:00:00Z' },
      { id: 'b', result: null, source: 'practice', createdAt: '2026-11-19T08:00:00Z' },
      { id: 'c', result: 'wrong', source: 'exam', createdAt: '2026-11-18T08:00:00Z', exam: { title: '期中' } },
      { id: 'd', result: 'not_attempted', source: 'weird', createdAt: '2026-11-17T08:00:00Z' },
    ]);
    expect(rows.map((r) => [r.id, r.label, r.source])).toEqual([['a', '对了', '自己标记'], ['c', '错了', '期中'], ['d', '不会', '']]);
    expect(toHistory(null)).toEqual([]);
    expect(toHistory(Array.from({ length: 50 }, (_, i) => ({ id: String(i), result: 'wrong', source: 'manual', createdAt: '' }))).length).toBe(30);
  });

  it('复习计划与掌握程度', () => {
    expect(toPlan(null)).toBeNull();
    expect(toPlan({ nextReviewAt: null, reviewDue: false, knowledgeMastery: [] })).toBeNull();
    const plan = toPlan({ nextReviewAt: '2026-12-01T00:00:00+08:00', reviewDue: true, knowledgeMastery: [{ knowledgePoint: '分数', score: 0.456, evidenceCount: 3 }] });
    expect(plan).toEqual({ next: expect.stringMatching(/^2026-1[12]-/), due: true, kps: [{ name: '分数', pct: 46 }] });
    expect(percent(2)).toBe(100);
    expect(percent(undefined)).toBe(0);
  });

  it('年级、来源、难度', () => {
    expect(metaLine({ gradeSemester: '七年级上', source: null, paperLevel: 'A' })).toBe('七年级上 · A 卷');
    expect(metaLine({})).toBe('');
    expect(stars(3)).toHaveLength(3);
    expect(stars(0)).toEqual([]);
    expect(stars(null)).toEqual([]);
  });

  it('配图 SVG 转 data URL；图片地址只认 https 和图片 data URL', () => {
    expect(utf8ToBase64('<svg>中</svg>')).toBe(Buffer.from('<svg>中</svg>', 'utf8').toString('base64'));
    expect(utf8ToBase64('ab')).toBe('YWI=');
    expect(utf8ToBase64('𝑥')).toBe(Buffer.from('𝑥', 'utf8').toString('base64'));
    expect(figureDataUrl('<svg viewBox="0 0 1 1"></svg>')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(figureDataUrl('<script>')).toBe('');
    expect(figureDataUrl(null)).toBe('');
    expect(safeImage('https://x.example/a.jpg')).toBe('https://x.example/a.jpg');
    expect(safeImage('data:image/jpeg;base64,AAA')).toBe('data:image/jpeg;base64,AAA');
    expect(safeImage('data:image/svg+xml;base64,AAA')).toBe('');
    expect(safeImage('http://x.example/a.jpg')).toBe('');
  });

  it('题目详情改判后，批改页只刷新一次', () => {
    markPaperChanged('p1');
    expect(takePaperChanged('p2')).toBe(false);
    expect(takePaperChanged('p1')).toBe(true);
    expect(takePaperChanged('p1')).toBe(false);
    expect(takePaperChanged('')).toBe(false);
  });
});
