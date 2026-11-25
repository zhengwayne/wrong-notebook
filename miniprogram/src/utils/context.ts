/** 各页面共用的登录上下文：会话、孩子列表、当前学习者 */
import type { XuejiGlobalData } from '../app';
import { getToken } from './request';
import { fetchChildren, fetchSession, resolveLearnerId, writeCurrentLearnerId } from './session';
import type { ChildLearner, MpSessionResponse } from './types';

export interface PageContext {
  session: MpSessionResponse;
  children: ChildLearner[];
  learnerId: string | null;
  learnerName: string;
  kidMode: boolean;
}

function globalData(): XuejiGlobalData {
  return getApp<{ globalData: XuejiGlobalData }>().globalData;
}

/** 未登录时跳转登录页并返回 null */
export async function loadContext(): Promise<PageContext | null> {
  if (!getToken()) {
    wx.reLaunch({ url: '/pages/login/login' });
    return null;
  }
  const session = await fetchSession();
  const children = await fetchChildren();
  const learnerId = resolveLearnerId(session, children);
  const data = globalData();
  data.session = session;
  data.learnerId = learnerId;
  const learner = children.find((child) => child.id === learnerId);
  return {
    session,
    children,
    learnerId,
    learnerName: learner ? learner.name : '我自己',
    kidMode: Boolean(session.kidModeLearnerId),
  };
}

export function switchLearner(userId: string, learnerId: string | null): void {
  writeCurrentLearnerId(userId, learnerId);
  globalData().learnerId = learnerId;
}

export function currentLearnerId(): string | null {
  return globalData().learnerId;
}

export function setReviewQueue(ids: string[]): void {
  globalData().reviewQueue = ids;
}

export function takeNextReview(currentId: string): string | null {
  const data = globalData();
  data.reviewQueue = data.reviewQueue.filter((id) => id !== currentId);
  return data.reviewQueue[0] ?? null;
}
