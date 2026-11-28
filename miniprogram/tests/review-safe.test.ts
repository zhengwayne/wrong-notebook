/**
 * 审核相关：界面文字不出现 AI 字样；
 * 0.1.3 起小程序不渲染答案、讲解、错因、参考答案（学英语固定词表的「看答案」除外）；
 * 「查看详情」在小程序里原生显示，不打开网页；只有「在电脑上做」复制一次性网页链接。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../src/utils/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/request')>();
  return { ...actual, request: requestMock };
});

import { API_BASE_URL, SHOW_SYNTH_MEDIA } from '../src/config';
import { ApiError, neutralMessage } from '../src/utils/request';
import { plainWebUrl, resolveWebLink } from '../src/utils/web-link';
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

  it('小程序不渲染答案、讲解、错因、参考答案', () => {
    const renderRe = /\{\{[^}]*\b(item\.answer|item\.analysis|item\.mistake|correctAnswer|errorCause|answerPlain|mistakePlain)\b[^}]*\}\}/;
    const labelRe = />\s*(答案|讲解|错因|参考答案|错在哪)\s*</;
    for (const file of files.filter((f) => f.endsWith('.wxml'))) {
      const rel = path.relative(SRC, file);
      const source = visibleSource(file);
      expect(source, rel).not.toMatch(renderRe);
      expect(source, rel).not.toMatch(labelRe);
      expect(source, rel).not.toContain('generatedLabel');
      expect(source, rel).not.toContain('AI 生成');
      if (rel.startsWith('pkg-xueji/') || rel.startsWith('pages/')) {
        expect(source, rel).not.toContain('看答案');
      }
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

describe('查看详情在小程序里原生显示，不打开网页', () => {
  beforeEach(() => requestMock.mockReset());

  it('没有 web-view 页面，也没有 <web-view> 组件', () => {
    const app = JSON.parse(fs.readFileSync(path.join(SRC, 'app.json'), 'utf8')) as { subPackages: Array<{ pages: string[] }> };
    const pages = app.subPackages.flatMap((pkg) => pkg.pages);
    expect(pages.some((page) => /webview/.test(page))).toBe(false);
    expect(pages).toEqual(expect.arrayContaining(['detail/detail', 'question/question', 'help/help']));
    for (const file of walk(SRC).filter((f) => f.endsWith('.wxml'))) expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/<web-view/);
  });

  it('查看详情、使用说明都跳原生页面', () => {
    const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(read('pkg-xueji/item/item.ts')).toMatch(/PAGES\.xjDetail/);
    expect(read('pkg-xueji/grade/grade.ts')).toMatch(/PAGES\.xjQuestion/);
    expect(read('pages/me/me.ts')).toMatch(/PAGES\.xjHelp/);
    expect(read('pkg-xueji/guide/guide.ts')).toMatch(/PAGES\.xjHelp/);
    for (const rel of ['pkg-xueji/item/item.ts', 'pkg-xueji/grade/grade.ts', 'pages/me/me.ts', 'pkg-xueji/guide/guide.ts']) expect(read(rel)).not.toMatch(/web-link/);
  });

  it('在电脑上做：优先一次性登录链接，失败退回普通地址，不是本站的地址不用', async () => {
    const url = `${API_BASE_URL}/api/auth/mp-handoff?t=xjwh_x&next=%2Fteacher`;
    requestMock.mockResolvedValueOnce({ url, expiresAt: '' });
    expect(await resolveWebLink('/teacher')).toEqual({ url, oneTime: true });
    expect(requestMock).toHaveBeenCalledWith('/api/mp/web-link', { method: 'POST', data: { path: '/teacher' } });
    requestMock.mockRejectedValueOnce(new ApiError(500, 'x'));
    expect(await resolveWebLink('/teacher')).toEqual({ url: plainWebUrl('/teacher'), oneTime: false });
    requestMock.mockResolvedValueOnce({ url: 'https://evil.example/x', expiresAt: '' });
    expect(await resolveWebLink('/teacher')).toEqual({ url: `${API_BASE_URL}/teacher`, oneTime: false });
  });

  it('专注模式不允许的页面不给链接', async () => {
    requestMock.mockRejectedValueOnce(new ApiError(403, '专注做题模式下禁止此操作', 'KID_MODE_RESTRICTED'));
    expect(await resolveWebLink('/teacher')).toBeNull();
  });
});
