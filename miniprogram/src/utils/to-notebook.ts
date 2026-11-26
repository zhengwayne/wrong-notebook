/**
 * 学英语 / 学数学里做错的题，一键收进学迹错题本（复用 POST /api/error-items，进对应学科的错题本）。
 * gradeSemester 传 null：不触发 AI 年级识别。重复的题由服务端去重。
 * 专注做题模式下服务端不允许新增错题（家长解锁后再收）。
 */
import type { XuejiGlobalData } from '../app';
import { request } from './request';

export interface NotebookDraft {
  subjectName: '英语' | '数学';
  questionText: string;
  answerText: string;
  analysis?: string;
  wrongAnswerText?: string;
  knowledgePoints?: string[];
}

export interface NotebookResult {
  added: number;
  duplicated: number;
}

export function buildErrorItemBody(draft: NotebookDraft, learnerId: string | null): Record<string, unknown> {
  return {
    subjectName: draft.subjectName,
    questionText: draft.questionText,
    answerText: draft.answerText,
    analysis: draft.analysis || '',
    wrongAnswerText: draft.wrongAnswerText || '',
    knowledgePoints: (draft.knowledgePoints || []).slice(0, 5),
    originalImageUrl: '',
    gradeSemester: null,
    learnerId: learnerId || null,
  };
}

export async function addToNotebook(drafts: NotebookDraft[]): Promise<NotebookResult> {
  const data = getApp<{ globalData: XuejiGlobalData }>().globalData;
  const result: NotebookResult = { added: 0, duplicated: 0 };
  for (const draft of drafts) {
    const res = await request<{ duplicate?: boolean }>('/api/error-items', {
      method: 'POST',
      data: buildErrorItemBody(draft, data.learnerId),
    });
    if (res && res.duplicate) result.duplicated += 1;
    else result.added += 1;
  }
  return result;
}

export function isKidMode(): boolean {
  const data = getApp<{ globalData: XuejiGlobalData }>().globalData;
  return Boolean(data.session && data.session.kidModeLearnerId);
}
