/**
 * 0.1.1 审核安全模式：小程序里不出现生成内容和 AI 字样；「查看详情」只复制链接（一次性网页登录链接，失败时退回普通地址）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../src/utils/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/request')>();
  return { ...actual, request: requestMock };
});

import { API_BASE_URL, SHOW_SYNTH_MEDIA } from '../src/config';
import { ApiError, neutralMessage } from '../src/utils/request';
import { COPIED_HINT, copyWebLink, errorItemPath, paperPath, plainWebUrl, resolveWebLink } from '../src/utils/web-link';
import { artUrl } from '../src/pkg-english/lib/words';
import { ATTRIBUTION, heroUrl } from '../src/pkg-math/lib/course';

const SRC = path.resolve(__dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 去掉注释后的源码（注释不会显示给用户） */
function visibleSource(file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.wxml')) return text.replace(/<!--[\s\S]*?-->/g, '');
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('界面文字不出现 AI / 生成字样', () => {
  const files = walk(SRC).filter((f) => /\.(wxml|ts|json)$/.test(f));
  it.each(files.map((f) => [path.relative(SRC, f), f]))('%s', (_rel, file) => {
    const source = visibleSource(file);
    // 字符串字面量与 wxml 文本里不能有独立的 AI 字样
    const texts = file.endsWith('.wxml')
      ? source.replace(/<[^>]*>/g, '\n').split('\n')
      : Array.from(source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g), (m) => m[2]);
    // 例外：request.ts 里把后端英文报错映射成中性中文的键，本身不会显示
    const shown = texts.filter((t) => t !== 'AI service is busy, please retry later');
    for (const text of shown) expect(text).not.toMatch(/(?<![A-Za-z])AI(?![A-Za-z_])/);
    expect(source).not.toMatch(/AI ?(生成|讲解|识别|判|建议|解析|问答)|人工智能|大模型|深度合成|举一反三/);
  });

  it('不展示生成的答案、解析、错因字段', () => {
    for (const file of files.filter((f) => f.endsWith('.wxml'))) {
      const source = visibleSource(file);
      expect(source, file).not.toMatch(/\{\{[^}]*\b(answerText|analysis|mistakeAnalysis|correctAnswer|errorCause|answerPlain|mistakePlain)\b[^}]*\}\}/);
    }
  });

  it('后端报错里的模型字样会被换成中性提示', () => {
    expect(neutralMessage('AI 服务超时')).toBe('识别服务暂时不可用，请稍后再试');
    expect(neutralMessage('AI_TIMEOUT')).toBe('识别服务暂时不可用，请稍后再试');
    expect(neutralMessage('模型返回为空')).toBe('识别服务暂时不可用，请稍后再试');
    expect(neutralMessage('图片太模糊')).toBe('图片太模糊');
    expect(neutralMessage('PAID')).toBe('PAID');
  });

  it('单词插图、数学插图默认不显示，署名里不提 AI', () => {
    expect(SHOW_SYNTH_MEDIA).toBe(false);
    expect(artUrl('apple')).toBe('');
    expect(heroUrl('l1', ['img/lessons/l1-hero.webp'])).toBe('');
    expect(ATTRIBUTION).not.toMatch(/AI/);
  });
});

describe('查看详情：复制网页链接', () => {
  const wxMock = {
    showLoading: vi.fn(), hideLoading: vi.fn(), hideToast: vi.fn(), showToast: vi.fn(), showModal: vi.fn(),
    setClipboardData: vi.fn((opts: { data: string; success?: () => void }) => opts.success && opts.success()),
  };
  beforeEach(() => {
    requestMock.mockReset();
    Object.values(wxMock).forEach((fn) => fn.mockClear());
    vi.stubGlobal('wx', wxMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('页面路径与网页端路由一致', () => {
    expect(errorItemPath('cm1')).toBe('/error-items/cm1');
    expect(paperPath('p1')).toBe('/parent/papers/p1');
    expect(plainWebUrl('/error-items/cm1')).toBe(`${API_BASE_URL}/error-items/cm1`);
  });

  it('优先复制一次性登录链接，并提示在浏览器打开', async () => {
    const url = `${API_BASE_URL}/api/auth/mp-handoff?t=xjwh_x&next=%2Ferror-items%2Fcm1`;
    requestMock.mockResolvedValue({ url, expiresAt: '' });
    await copyWebLink('/error-items/cm1');
    expect(requestMock).toHaveBeenCalledWith('/api/mp/web-link', { method: 'POST', data: { path: '/error-items/cm1' } });
    expect(wxMock.setClipboardData).toHaveBeenCalledWith(expect.objectContaining({ data: url }));
    const modal = wxMock.showModal.mock.calls[0][0] as { content: string };
    expect(modal.content).toContain(COPIED_HINT);
    expect(modal.content).not.toMatch(/AI/);
  });

  it('签发失败时退回普通网页地址；不是本站的地址不复制', async () => {
    requestMock.mockRejectedValueOnce(new ApiError(500, 'x'));
    expect(await resolveWebLink('/error-items/cm1')).toEqual({ url: `${API_BASE_URL}/error-items/cm1`, oneTime: false });
    requestMock.mockResolvedValueOnce({ url: 'https://evil.example/x', expiresAt: '' });
    expect(await resolveWebLink('/error-items/cm1')).toEqual({ url: `${API_BASE_URL}/error-items/cm1`, oneTime: false });
  });

  it('专注模式不允许的页面不复制', async () => {
    requestMock.mockRejectedValue(new ApiError(403, '专注做题模式下禁止此操作', 'KID_MODE_RESTRICTED'));
    await copyWebLink('/parent/papers/p1');
    expect(wxMock.setClipboardData).not.toHaveBeenCalled();
    expect(wxMock.showToast).toHaveBeenCalled();
  });
});
