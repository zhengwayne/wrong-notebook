/** 登录态与当前学习者（孩子）选择 */
import { clearSession, request, setToken } from './request';
import type { ChildLearner, MpLoginResponse, MpSessionResponse, MpUser } from './types';

const LEARNER_KEY_PREFIX = 'xueji.mp.learner:';

export interface LoginOutcome {
  user: MpUser;
  created: boolean;
}

function wxLoginCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('微信登录失败'))),
      fail: reject,
    });
  });
}

/** 微信一键登录：已用过直接进入；第一次用会自动建一个只用微信登录的账号 */
export async function loginWithWechat(): Promise<LoginOutcome> {
  const code = await wxLoginCode();
  const res = await request<MpLoginResponse>('/api/mp/login', { method: 'POST', data: { code } });
  if (!res.token) throw new Error('登录失败，请重试');
  setToken(res.token);
  return { user: res.user, created: Boolean(res.created) };
}

/**
 * 可选：把当前微信关联到网页端已有账号（邮箱 + 密码）。
 * 成功后换成网页账号的令牌，原来的空微信账号由服务端删除；微信账号里已有数据时服务端会拒绝。
 */
export async function linkWebAccount(email: string, password: string): Promise<MpUser> {
  const res = await request<MpLoginResponse>('/api/mp/bind', { method: 'POST', data: { email, password } });
  if (!res.token) throw new Error('关联失败，请重试');
  setToken(res.token);
  wx.removeStorageSync('xueji.mp.kidLock');
  return res.user;
}

export async function updateDisplayName(name: string): Promise<MpUser> {
  const res = await request<{ user: MpUser }>('/api/mp/profile', { method: 'POST', data: { name } });
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
