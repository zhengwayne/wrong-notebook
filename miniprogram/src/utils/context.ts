/** 各页面共用的登录上下文：会话、孩子列表、当前学习者 */
import type { XuejiGlobalData } from '../app';
import { clearKidLock, getToken, hasKidLockCookie, request } from './request';
import { fetchChildren, fetchSession, resolveLearnerId, writeCurrentLearnerId } from './session';
import type { ChildLearner, KidModeStatus, MpSessionResponse } from './types';

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
  // 服务端已不认这把锁（过期 / 家长在网页端解锁 / 重新登录）：清掉本地残留，重启后也不会卡在专注模式
  if (!session.kidModeLearnerId && hasKidLockCookie()) clearKidLock();
  const children = session.kidModeLearnerId ? await kidModeChildren() : await fetchChildren();
  const learnerId = resolveLearnerId(session, children);
  const data = globalData();
  data.session = session;
  data.learnerId = learnerId;
  const learner = children.find((child) => child.id === learnerId);
  return {
    session,
    children,
    learnerId,
    learnerName: learner ? learner.name : session.kidModeLearnerId ? '孩子' : '我自己',
    kidMode: Boolean(session.kidModeLearnerId),
  };
}

/**
 * 专注模式下 /api/learners 会被专注锁网关拦下（403），不能用它拿孩子列表；
 * 改读专注模式允许的 GET /api/parent/kid-mode 拿当前孩子的名字。读失败也不阻塞页面（名字退回“孩子”）。
 */
async function kidModeChildren(): Promise<ChildLearner[]> {
  try {
    const status = await request<KidModeStatus>('/api/parent/kid-mode');
    if (status.active && status.learnerId) {
      return [{ id: status.learnerId, name: status.learnerName || '孩子', itemCount: 0 }];
    }
  } catch {
    // 忽略：解锁入口不依赖孩子名字
  }
  return [];
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
