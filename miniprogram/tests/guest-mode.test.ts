/**
 * 游客模式（审核要求）：不登录就能浏览全部页面，只有真正用到功能（拍照、识别、保存、记录、笔记）时才弹登录框。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

interface Store { [key: string]: unknown }

function stubWx(store: Store = {}) {
  const globalData = { session: null as unknown, learnerId: null as string | null, reviewQueue: [] as string[] };
  const wxMock = {
    getStorageSync: vi.fn((key: string) => store[key] ?? ''),
    setStorageSync: vi.fn((key: string, value: unknown) => { store[key] = value; }),
    removeStorageSync: vi.fn((key: string) => { delete store[key]; }),
    request: vi.fn(),
    uploadFile: vi.fn(),
    showToast: vi.fn(),
    reLaunch: vi.fn(),
  };
  vi.stubGlobal('wx', wxMock);
  vi.stubGlobal('getApp', () => ({ globalData }));
  vi.stubGlobal('getCurrentPages', () => []);
  return { wxMock, globalData, store };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('启动不强制登录', () => {
  it('没有单独的登录页，首页是三合一首页', () => {
    const app = JSON.parse(read('app.json')) as { pages: string[] };
    expect(app.pages[0]).toBe('pages/hub/hub');
    expect(app.pages).not.toContain('pages/login/login');
    expect(fs.existsSync(path.join(SRC, 'pages/login'))).toBe(false);
  });

  it('代码里没有跳转登录页，401 也不再 reLaunch 登录页', () => {
    for (const file of walk(SRC).filter((f) => /\.(ts|wxml|json)$/.test(f))) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, path.relative(SRC, file)).not.toMatch(/goLogin|pages\/login/);
    }
  });

  it('loadContext 没有令牌时返回游客上下文：不发请求、不跳转', async () => {
    const { wxMock, globalData } = stubWx();
    const { loadContext } = await import('../src/utils/context');
    const ctx = await loadContext();
    expect(ctx.guest).toBe(true);
    expect(ctx.children).toEqual([]);
    expect(ctx.learnerId).toBeNull();
    expect(ctx.kidMode).toBe(false);
    expect(globalData.session).toBeNull();
    expect(wxMock.request).not.toHaveBeenCalled();
    expect(wxMock.reLaunch).not.toHaveBeenCalled();
  });

  it('游客调用需要登录的接口：直接按 401 处理，不发网络请求，也不跳转', async () => {
    const { wxMock } = stubWx();
    const { request, uploadImage, ApiError, toChineseMessage } = await import('../src/utils/request');
    await expect(request('/api/review/due')).rejects.toBeInstanceOf(ApiError);
    await expect(request('/api/notebooks')).rejects.toMatchObject({ status: 401 });
    await expect(uploadImage('/api/analyze-image', '/tmp/a.jpg')).rejects.toMatchObject({ status: 401 });
    expect(wxMock.request).not.toHaveBeenCalled();
    expect(wxMock.uploadFile).not.toHaveBeenCalled();
    expect(wxMock.reLaunch).not.toHaveBeenCalled();
    expect(toChineseMessage(new ApiError(401, 'Unauthorized'))).toBe('请先登录');
  });

  it('登录接口游客也能调用', async () => {
    const { wxMock } = stubWx();
    wxMock.request.mockImplementation((opts: { success: (r: unknown) => void }) => opts.success({ statusCode: 200, data: { ok: 1 }, header: {} }));
    const { request } = await import('../src/utils/request');
    await expect(request('/api/mp/login', { method: 'POST', data: { code: 'x' } })).resolves.toEqual({ ok: 1 });
    expect(wxMock.request).toHaveBeenCalledTimes(1);
  });

  it('令牌失效（服务端 401）：清掉登录状态并回到首页按游客显示', async () => {
    const { wxMock, store, globalData } = stubWx({ 'xueji.mp.token': 'xjmp_old' });
    globalData.session = { user: { id: 'u1' } };
    wxMock.request.mockImplementation((opts: { success: (r: unknown) => void }) => opts.success({ statusCode: 401, data: { message: 'Unauthorized' }, header: {} }));
    const { request } = await import('../src/utils/request');
    await expect(request('/api/review/due')).rejects.toMatchObject({ status: 401 });
    expect(store['xueji.mp.token']).toBeUndefined();
    expect(globalData.session).toBeNull();
    expect(wxMock.reLaunch).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/hub/hub' }));
  });
});

describe('用到功能时才登录', () => {
  it('已登录直接放行；没有登录框的页面给出提示并返回 false', async () => {
    const { wxMock } = stubWx({ 'xueji.mp.token': 'xjmp_x' });
    const { requireLogin } = await import('../src/utils/auth');
    await expect(requireLogin()).resolves.toBe(true);
    wxMock.getStorageSync.mockImplementation(() => '');
    await expect(requireLogin()).resolves.toBe(false);
    expect(wxMock.showToast).toHaveBeenCalled();
  });

  it('游客：弹出当前页的登录框，结果由登录框决定', async () => {
    stubWx();
    const open = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    vi.stubGlobal('getCurrentPages', () => [{ selectComponent: (selector: string) => (selector === '#login-sheet' ? { open } : null) }]);
    const { requireLogin } = await import('../src/utils/auth');
    await expect(requireLogin('拍照识别需要登录')).resolves.toBe(true);
    await expect(requireLogin()).resolves.toBe(false);
    expect(open).toHaveBeenCalledWith('拍照识别需要登录');
  });

  it('所有会写数据 / 拍照识别的操作在做之前先要求登录', () => {
    const gates: Array<[string, string, string]> = [
      ['pkg-xueji/capture/capture.ts', 'async onChoose', 'wx.chooseMedia'],
      ['pkg-xueji/capture/capture.ts', 'async onAnalyze', 'uploadImage'],
      ['pkg-xueji/capture/capture.ts', 'async onSave()', "request<"],
      ['pkg-xueji/item/item.ts', 'async onRecord', '/api/practice/record'],
      ['pkg-xueji/detail/detail.ts', 'async onEditNotes', 'wx.showModal'],
      ['pkg-xueji/notebook/notebook.ts', 'async onCreateSubmit', "'/api/notebooks'"],
      ['pkg-xueji/home/home.ts', 'async onSavePersona', '/api/persona'],
      ['pkg-english/words/words.ts', 'async onSaveAll', 'addToNotebook(drafts)'],
      ['pkg-english/practice/practice.ts', 'async onSaveWrong', 'addToNotebook(drafts)'],
      ['pkg-math/quiz/quiz.ts', 'async onSaveWrong', 'addToNotebook(drafts)'],
    ];
    for (const [file, fn, write] of gates) {
      const source = read(file);
      const start = source.indexOf(fn);
      expect(start, `${file} ${fn}`).toBeGreaterThan(-1);
      const body = source.slice(start);
      const gate = body.indexOf('requireLogin(');
      const action = body.indexOf(write);
      expect(gate, `${file} ${fn} 缺少 requireLogin`).toBeGreaterThan(-1);
      expect(gate, `${file} ${fn} 要先登录再操作`).toBeLessThan(action);
    }
  });

  it('用到 requireLogin 的页面，模板里都有 <login-sheet id="login-sheet" />', () => {
    const app = JSON.parse(read('app.json')) as { pages: string[]; subPackages: Array<{ root: string; pages: string[] }> };
    const pages = [...app.pages, ...app.subPackages.flatMap((pkg) => pkg.pages.map((page) => `${pkg.root}/${page}`))];
    let used = 0;
    for (const page of pages) {
      if (!/requireLogin\(/.test(read(`${page}.ts`))) continue;
      used += 1;
      expect(read(`${page}.wxml`), page).toMatch(/<login-sheet id="login-sheet"\s*\/>/);
    }
    expect(used).toBeGreaterThanOrEqual(10);
    expect((JSON.parse(read('app.json')) as { usingComponents: Record<string, string> }).usingComponents['login-sheet']).toBe('/components/login-sheet/login-sheet');
  });

  it('首页、错题本、复习、我的在游客状态下不发请求（先判断 guest）', () => {
    const pages = ['pages/hub/hub', 'pkg-xueji/home/home', 'pkg-xueji/notebook/notebook', 'pkg-xueji/review/review', 'pages/me/me', 'pkg-xueji/parent/parent', 'pkg-xueji/capture/capture'];
    for (const page of pages) {
      const source = read(`${page}.ts`);
      const guestAt = source.indexOf('ctx.guest');
      expect(guestAt, page).toBeGreaterThan(-1);
      const firstRequest = source.search(/\brequest</);
      expect(firstRequest, page).toBeGreaterThan(-1);
      expect(guestAt, page).toBeLessThan(firstRequest);
    }
  });
});

describe('登录框', () => {
  const ts = read('components/login-sheet/login-sheet.ts');
  const wxml = read('components/login-sheet/login-sheet.wxml');

  it('隐私协议默认不勾选；没勾选不能登录；有隐私指引链接和「暂不登录」', () => {
    expect(ts).toMatch(/agreed: false/);
    expect(ts).toMatch(/if \(!this\.data\.agreed\)/);
    expect(ts).toMatch(/wx\.openPrivacyContract/);
    expect(wxml).toMatch(/暂不登录/);
    expect(wxml).toMatch(/微信一键登录/);
    expect(wxml).toMatch(/《用户隐私保护指引》/);
    expect(wxml).toMatch(/bindtap="onCancel"/);
  });

  it('只有微信登录，没有账号密码输入', () => {
    expect(wxml).not.toMatch(/<input|password|邮箱|手机号/);
  });

  it('「我的」里游客有登录入口，隐私保护指引不登录也能看', () => {
    const me = read('pages/me/me.wxml');
    const guestBlock = me.slice(me.indexOf('wx:if="{{guest}}"'), me.indexOf('wx:elif="{{user}}"'));
    expect(guestBlock).toMatch(/bindtap="onLogin"/);
    expect(guestBlock).toMatch(/bindtap="onPrivacy"/);
    expect(guestBlock).toMatch(/隐私保护指引/);
  });
});

describe('游客的学习进度与示例题', () => {
  it('学英语 / 学数学没登录时存在本机的游客位置；登录后并入账号，账号已有的不覆盖', async () => {
    const store: Store = {};
    stubWx(store);
    const mod = await import('../src/utils/module-store');
    mod.writeModule('english', { ...mod.ENGLISH_DEFAULTS, book: 'grade_4上' });
    expect(store[mod.moduleKey('english', mod.GUEST_USER_ID, null)]).toMatchObject({ book: 'grade_4上' });
    expect(mod.readModule('english', mod.ENGLISH_DEFAULTS).book).toBe('grade_4上');

    store[mod.moduleKey('math', mod.GUEST_USER_ID, null)] = { best: { a: 90 }, perfect: 1 };
    store[mod.moduleKey('math', 'u1', null)] = { best: { b: 100 }, perfect: 2 };
    mod.migrateGuestProgress('u1');
    expect(store[mod.moduleKey('english', 'u1', null)]).toMatchObject({ book: 'grade_4上' });
    expect(store[mod.moduleKey('math', 'u1', null)]).toMatchObject({ perfect: 2 });
    expect(store[mod.moduleKey('english', mod.GUEST_USER_ID, null)]).toBeUndefined();
    expect(store[mod.moduleKey('math', mod.GUEST_USER_ID, null)]).toBeUndefined();
  });

  it('示例题：没有答案、讲解、错因，数据本地生成', async () => {
    const { SAMPLE_ID, isSampleId, sampleDetail, sampleRecords, sampleSummary } = await import('../src/utils/sample');
    expect(isSampleId(SAMPLE_ID)).toBe(true);
    expect(isSampleId('abc')).toBe(false);
    const detail = sampleDetail();
    expect(detail.answerText).toBeNull();
    expect(detail.analysis).toBeNull();
    expect(detail.mistakeAnalysis).toBeNull();
    expect(sampleSummary().questionText).toBeTruthy();
    expect(sampleRecords().records.length).toBeGreaterThan(0);
  });
});
