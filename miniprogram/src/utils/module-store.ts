/**
 * 学英语 / 学数学的学习进度先存在本机（按账号 + 当前学习者分开），不占后端。
 * 单个 key 不超过 1 MB：只存每个单词 / 每一课的精简状态。
 */
import type { XuejiGlobalData } from '../app';
import { getToken } from './request';

export type ModuleName = 'english' | 'math';

function globalData(): XuejiGlobalData {
  return getApp<{ globalData: XuejiGlobalData }>().globalData;
}

export function moduleKey(module: ModuleName, userId: string, learnerId: string | null): string {
  return `xueji.mp.${module}:${userId}:${learnerId || 'self'}`;
}

/** 游客的学习进度先存在本机；登录后并入账号（见 migrateGuestProgress） */
export const GUEST_USER_ID = 'guest';

function currentKey(module: ModuleName): string | null {
  const data = globalData();
  if (!data.session) return getToken() ? null : moduleKey(module, GUEST_USER_ID, null);
  return moduleKey(module, data.session.user.id, data.learnerId);
}

export function readModule<T extends object>(module: ModuleName, defaults: T): T {
  const key = currentKey(module);
  if (!key) return { ...defaults };
  const raw = wx.getStorageSync(key) as Partial<T> | '';
  return raw && typeof raw === 'object' ? { ...defaults, ...raw } : { ...defaults };
}

export function writeModule<T extends object>(module: ModuleName, value: T): void {
  const key = currentKey(module);
  if (key) wx.setStorageSync(key, value);
}

/** 学英语：每个单词的复习状态（盒子 0-5，到期时间，错的次数，释义与音标的精简副本） */
export interface WordState {
  b: number;
  d: number;
  w: number;
  t: string;
  p: string;
  k: string;
  /** 上次拼错的写法 */
  x?: string;
}

export interface EnglishStore {
  book: string;
  mode: 'spell' | 'dictation';
  words: Record<string, WordState>;
  /** 每本书每一关的星数（0-3） */
  levels: Record<string, Record<string, number>>;
}

export const ENGLISH_DEFAULTS: EnglishStore = { book: 'grade_3上', mode: 'spell', words: {}, levels: {} };

/** 学数学：每一课最好成绩（百分比），≥80 算点亮 */
export interface MathStore {
  best: Record<string, number>;
  perfect: number;
}

export const MATH_DEFAULTS: MathStore = { best: {}, perfect: 0 };
export const MATH_PASS = 80;

export function englishDueCount(store: EnglishStore, now = Date.now()): number {
  return Object.values(store.words).filter((word) => word.d <= now).length;
}

export function mathStarCount(store: MathStore): number {
  return Object.values(store.best).filter((score) => score >= MATH_PASS).length;
}

/** 登录后把游客时的学习进度并入账号（账号里已有进度就保留账号的，游客的留着不覆盖） */
export function migrateGuestProgress(userId: string): void {
  for (const name of ['english', 'math'] as const) {
    const guestKey = moduleKey(name, GUEST_USER_ID, null);
    const guest = wx.getStorageSync(guestKey) as unknown;
    if (!guest || typeof guest !== 'object') continue;
    const userKey = moduleKey(name, userId, null);
    const mine = wx.getStorageSync(userKey) as unknown;
    if (!mine || typeof mine !== 'object') wx.setStorageSync(userKey, guest);
    wx.removeStorageSync(guestKey);
  }
}
