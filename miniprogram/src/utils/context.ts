/** 各页面共用的登录上下文：会话、孩子列表、当前学习者 */
import type { XuejiGlobalData } from '../app';
import { clearKidLock, getToken, hasKidLockCookie, request } from './request';
import { fetchChildren, fetchSession, resolveLearnerId, writeCurrentLearnerId } from './session';
import type { ChildLearner, KidModeStatus, MpSessionResponse } from './types';

export interface PageContext {
  /** true：没登录（游客）。游客没有会话、没有孩子，页面只显示示例与空状态，不发需要登录的请求 */
  guest: boolean;
  session: MpSessionResponse;
  children: ChildLearner[];
  learnerId: string | null;
  learnerName: string;
  kidMode: boolean;
}

function globalData(): XuejiGlobalData {
  return getApp<{ globalData: XuejiGlobalData }>().globalData;
}

/** 游客的占位会话：只给页面读取显示用，不会发给服务端 */
export const GUEST_SESSION: MpSessionResponse = {
  user: { id: 'guest', email: null, wechatOnly: true, name: null, role: 'user', personas: [], activePersona: null, personasConfirmed: true },
  expiresAt: '',
  kidModeLearnerId: null,
};

/** 没登录时返回游客上下文（不发任何请求、不跳登录页）；登录在用到功能时再弹登录框 */
export async function loadContext(): Promise<PageContext> {
  if (!getToken()) {
    const data = globalData();
    data.session = null;
    data.learnerId = null;
    return { guest: true, session: GUEST_SESSION, children: [], learnerId: null, learnerName: '我自己', kidMode: false };
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
    guest: false,
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
