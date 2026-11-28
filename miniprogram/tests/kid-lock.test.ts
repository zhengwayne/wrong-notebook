import { describe, expect, it } from 'vitest';
import { classifyUnlockFailure, pressPinKey } from '../src/utils/kid-lock';

describe('mini program kid-lock pad', () => {
  it('accepts at most 4 digits and supports delete', () => {
    let pin = '';
    for (const key of ['1', '2', 'x', '3', '4', '5']) pin = pressPinKey(pin, key);
    expect(pin).toBe('1234');
    expect(pressPinKey(pin, 'del')).toBe('123');
    expect(pressPinKey('', 'del')).toBe('');
  });

  it('classifies unlock failures from the existing API', () => {
    expect(classifyUnlockFailure({ errMsg: 'request:fail timeout' })).toEqual({ kind: 'network', message: '网络超时' });
    expect(classifyUnlockFailure({ errMsg: 'request:fail' }).kind).toBe('network');
    expect(classifyUnlockFailure({ status: 504, message: '' }).kind).toBe('network');
    expect(classifyUnlockFailure({ status: 403, message: 'PIN 码错误，还可尝试 3 次' })).toEqual({
      kind: 'wrong',
      message: 'PIN 码错误，还可尝试 3 次',
    });
    expect(classifyUnlockFailure({ status: 429, message: 'PIN 连续输错 5 次，已锁定 15 分钟' }).kind).toBe('locked');
    expect(classifyUnlockFailure({ status: 400, message: '当前账户尚未设置家长 PIN 码' }).kind).toBe('nopin');
    expect(classifyUnlockFailure({ status: 500, message: 'boom' })).toEqual({ kind: 'other', message: 'boom' });
  });
});

describe('mini program kid-mode API usage matches the gateway allowlist', () => {
  it('only calls allowed endpoints while locked', async () => {
    const { isApiAllowedInKidMode } = await import('../../src/lib/kid-mode-lock');
    // 专注模式下小程序会调用的接口都必须放行，否则页面加载失败、连解锁入口都出不来
    expect(isApiAllowedInKidMode('/api/mp/session', 'GET')).toBe(true);
    expect(isApiAllowedInKidMode('/api/parent/kid-mode', 'GET')).toBe(true);
    expect(isApiAllowedInKidMode('/api/parent/kid-mode/unlock', 'POST')).toBe(true);
    expect(isApiAllowedInKidMode('/api/review/due', 'GET')).toBe(true);
    // 孩子列表、错题本列表在专注模式下被拒（网页端 /notebooks 页面同样不开放）：loadContext 与错题本页必须绕开它们（原问题的根因）
    expect(isApiAllowedInKidMode('/api/learners', 'GET')).toBe(false);
    expect(isApiAllowedInKidMode('/api/notebooks', 'GET')).toBe(false);
  });
});
