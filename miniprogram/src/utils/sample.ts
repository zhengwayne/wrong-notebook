/**
 * 游客（没登录）看到的示例错题：让人不登录也能浏览错题本、复习、题目详情的样子。
 * 只存在本机、不发请求；示例题不能记录、不能写笔记（点了会请登录，登录后用自己的错题）。
 * 示例里没有答案、讲解、错因。
 */
import type { LearningContext, PracticeRecordRow } from './detail';
import type { ErrorItemDetail, ErrorItemSummary } from './types';

export const SAMPLE_ID = 'sample';

export function isSampleId(id: string | null | undefined): boolean {
  return id === SAMPLE_ID;
}

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number, now: number): string {
  return new Date(now - days * DAY).toISOString();
}

export function sampleSummary(now = Date.now()): ErrorItemSummary {
  return {
    id: SAMPLE_ID,
    questionText: '一个长方形的长是 8 厘米，宽是 5 厘米，它的周长是多少厘米？',
    knowledgePoints: JSON.stringify(['长方形周长']),
    masteryStatus: 'reviewing',
    createdAt: daysAgo(3, now),
    reviewStage: 0,
    nextReviewAt: new Date(now).toISOString(),
  };
}

export type SampleDetail = ErrorItemDetail & {
  gradeSemester: string;
  difficultyStars: number;
  learning: LearningContext;
};

export function sampleDetail(now = Date.now()): SampleDetail {
  return {
    ...sampleSummary(now),
    answerText: null,
    analysis: null,
    wrongAnswerText: '40',
    mistakeAnalysis: null,
    originalImageUrl: null,
    subject: { id: 'sample-math', name: '数学' },
    userNotes: null,
    gradeSemester: '三年级上册',
    difficultyStars: 2,
    learning: {
      nextReviewAt: new Date(now).toISOString(),
      reviewDue: true,
      knowledgeMastery: [{ knowledgePoint: '长方形周长', score: 0.4, evidenceCount: 2 }],
    },
  };
}

export function sampleRecords(now = Date.now()): { masteryProbability: number; records: PracticeRecordRow[] } {
  return {
    masteryProbability: 0.4,
    records: [
      { id: 's2', result: 'correct', source: 'manual', createdAt: daysAgo(1, now) },
      { id: 's1', result: 'wrong', source: 'manual', createdAt: daysAgo(3, now) },
    ],
  };
}
