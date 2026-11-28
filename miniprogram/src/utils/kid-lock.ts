/**
 * 专注模式解锁面板的纯逻辑（不依赖 wx，便于单测）：
 * - PIN 键盘输入；
 * - 把解锁接口的各种失败归类成面板要展示的状态。
 * 语义与网页端 GlobalKidModeBanner 一致：只能用 4 位家长 PIN 经 POST /api/parent/kid-mode/unlock 解锁。
 */

export const PIN_LENGTH = 4;

export type PinKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'del';

export function pressPinKey(pin: string, key: string): string {
  if (key === 'del') return pin.slice(0, -1);
  if (!/^\d$/.test(key) || pin.length >= PIN_LENGTH) return pin;
  return pin + key;
}

export type UnlockFailureKind = 'network' | 'wrong' | 'locked' | 'nopin' | 'other';

export interface UnlockFailure {
  kind: UnlockFailureKind;
  message: string;
}

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  errMsg?: unknown;
}

/** 把请求失败归类：网络问题可重试（保留已输 PIN），输错清空重输，锁定/没设 PIN 给出说明 */
export function classifyUnlockFailure(error: unknown): UnlockFailure {
  const e = (error && typeof error === 'object' ? error : {}) as ErrorLike;
  const message = typeof e.message === 'string' ? e.message : '';
  if (typeof e.errMsg === 'string') {
    return { kind: 'network', message: e.errMsg.includes('timeout') ? '网络超时' : '网络连接失败' };
  }
  const status = typeof e.status === 'number' ? e.status : 0;
  // 网关/超时且没有业务消息：也当作网络问题，允许原样重试
  if (!message && [0, 502, 503, 504, 524].includes(status)) return { kind: 'network', message: '服务器没响应' };
  if (status === 429) return { kind: 'locked', message: message || 'PIN 输错太多次，15 分钟后再试' };
  if (status === 403) return { kind: 'wrong', message: message || 'PIN 码不对' };
  if (status === 400 && message.includes('尚未设置')) {
    return { kind: 'nopin', message: '这个账号还没设家长 PIN，专注锁 12 小时内会自动解除' };
  }
  return { kind: 'other', message: message || `解锁失败（${status || '未知'}）` };
}
