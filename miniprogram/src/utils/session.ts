/** 登录态与当前学习者（孩子）选择 */
import { clearSession, request, setToken } from './request';
import type { ChildLearner, MpLoginResponse, MpSessionResponse, MpUser } from './types';

const LEARNER_KEY_PREFIX = 'xueji.mp.learner:';

export interface LoginOutcome {
  user?: MpUser;
  bindTicket?: string;
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('微信登录失败'))),
      fail: reject,
    });
  });
}

/** 微信登录：已绑定直接拿到令牌；未绑定返回绑定凭证 */
export async function loginWithWechat(): Promise<LoginOutcome> {
  const code = await wxLoginCode();
  const res = await request<MpLoginResponse>('/api/mp/login', { method: 'POST', data: { code } });
  if (res.status === 'ok' && res.token) {
    setToken(res.token);
    return { user: res.user };
  }
  return { bindTicket: res.bindTicket };
}

export async function bindAccount(bindTicket: string, email: string, password: string): Promise<MpUser | undefined> {
  const res = await request<MpLoginResponse>('/api/mp/bind', {
    method: 'POST',
    data: { bindTicket, email, password },
  });
  if (res.token) setToken(res.token);
  return res.user;
}

export function fetchSession(): Promise<MpSessionResponse> {
  return request<MpSessionResponse>('/api/mp/session');
}

export async function logout(): Promise<void> {
  try {
    await request('/api/mp/session', { method: 'DELETE' });
  } finally {
    clearSession();
  }
}

export async function unbindWechat(): Promise<void> {
  await request('/api/mp/binding', { method: 'DELETE' });
  clearSession();
}

export function readCurrentLearnerId(userId: string): string | null {
  return (wx.getStorageSync(`${LEARNER_KEY_PREFIX}${userId}`) as string) || null;
}

export function writeCurrentLearnerId(userId: string, learnerId: string | null): void {
  if (learnerId) wx.setStorageSync(`${LEARNER_KEY_PREFIX}${userId}`, learnerId);
  else wx.removeStorageSync(`${LEARNER_KEY_PREFIX}${userId}`);
}

export async function fetchChildren(): Promise<ChildLearner[]> {
  const res = await request<{ children: ChildLearner[] }>('/api/learners');
  return res.children ?? [];
}

/**
 * 当前作用的学习者：专注锁优先；家长身份默认第一个孩子；无孩子或自学/老师身份为 null（本人）。
 */
export function resolveLearnerId(
  session: MpSessionResponse,
  children: ChildLearner[],
): string | null {
  if (session.kidModeLearnerId) return session.kidModeLearnerId;
  const stored = readCurrentLearnerId(session.user.id);
  if (stored && children.some((child) => child.id === stored)) return stored;
  if (session.user.activePersona === 'parent' && children.length > 0) return children[0].id;
  return null;
}
