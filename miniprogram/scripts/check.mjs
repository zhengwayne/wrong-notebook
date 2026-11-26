#!/usr/bin/env node
/**
 * 小程序静态检查（无需微信开发者工具）：
 * 1. app.json 中主包与分包的每个页面都有 .ts / .wxml / .wxss / .json 四个文件；专注锁条、错题本底栏、包体大小；
 * 2. 所有 .json 可解析；样式与模板中不出现渐变（UI 规范：薰衣草紫纯色、无渐变）；
 * 3. 代码里不出现疑似 AppSecret；
 * 4. 纯函数（文本转换、反馈令牌解析）的冒烟断言。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const problems = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const app = JSON.parse(fs.readFileSync(path.join(src, 'app.json'), 'utf8'));
// 三合一：主包（首页 / 登录 / 我的）+ 分包（错题本、学英语、学数学）
const subPackages = app.subPackages ?? [];
const allPages = [...app.pages, ...subPackages.flatMap((pkg) => pkg.pages.map((page) => `${pkg.root}/${page}`))];
for (const page of allPages) {
  for (const ext of ['.ts', '.wxml', '.wxss', '.json']) {
    if (!fs.existsSync(path.join(src, `${page}${ext}`))) problems.push(`页面缺少文件：${page}${ext}`);
  }
}
if (app.tabBar) problems.push('三合一后不用原生 tabBar（tabBar 页面只能在主包），错题本用自定义底栏 <xj-tabbar>');
for (const pkg of subPackages) {
  if (!pkg.name) problems.push(`分包缺少 name（preloadRule 用）：${pkg.root}`);
  for (const other of subPackages) if (other !== pkg && other.root.startsWith(pkg.root)) problems.push(`分包目录重叠：${pkg.root}`);
}
for (const [page, rule] of Object.entries(app.preloadRule ?? {})) {
  if (!allPages.includes(page)) problems.push(`preloadRule 页面未注册：${page}`);
  for (const name of rule.packages ?? []) if (!subPackages.some((pkg) => pkg.name === name || pkg.root === name)) problems.push(`preloadRule 分包不存在：${name}`);
}
// 组件都有四个文件（全局组件 + 页面里声明的组件）
const componentRefs = Object.entries(app.usingComponents ?? {}).map(([name, comp]) => [name, comp, 'app.json']);
for (const page of allPages) {
  const jsonFile = path.join(src, `${page}.json`);
  if (!fs.existsSync(jsonFile)) continue;
  try {
    for (const [name, comp] of Object.entries(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).usingComponents ?? {})) componentRefs.push([name, comp, page]);
  } catch { /* JSON 错误在下面统一报告 */ }
}
for (const [name, comp, owner] of componentRefs) {
  for (const ext of ['.ts', '.wxml', '.wxss', '.json']) {
    if (!fs.existsSync(path.join(src, `${comp}${ext}`))) problems.push(`组件 ${name}（${owner}）缺少文件：${comp}${ext}`);
  }
}
// 专注锁条：三合一首页、我的、错题本的三个底栏页都要有，保证专注模式下随处能找到解锁入口
const XJ_TAB_PAGES = ['pkg-xueji/home/home', 'pkg-xueji/notebook/notebook', 'pkg-xueji/review/review'];
const KID_LOCK_PAGES = [app.pages[0], 'pages/me/me', ...XJ_TAB_PAGES];
if (app.pages[0] !== 'pages/hub/hub') problems.push(`启动页应为三合一首页 pages/hub/hub：${app.pages[0]}`);
for (const page of KID_LOCK_PAGES) {
  const wxmlFile = path.join(src, `${page}.wxml`);
  const wxml = fs.existsSync(wxmlFile) ? fs.readFileSync(wxmlFile, 'utf8') : '';
  if (!/<kid-lock\b[^>]*bind:unlocked=/.test(wxml)) problems.push(`页面缺少专注锁条 <kid-lock bind:unlocked>：${page}`);
}
for (const page of XJ_TAB_PAGES) {
  const wxmlFile = path.join(src, `${page}.wxml`);
  const wxml = fs.existsSync(wxmlFile) ? fs.readFileSync(wxmlFile, 'utf8') : '';
  if (!/<xj-tabbar\b[^>]*active=/.test(wxml)) problems.push(`错题本底栏页缺少 <xj-tabbar active>：${page}`);
}
// 不再有原生 tabBar：代码里不能再调用 wx.switchTab
for (const file of walk(src)) {
  if (file.endsWith('.ts') && /wx\.switchTab\s*\(/.test(fs.readFileSync(file, 'utf8'))) problems.push(`没有原生 tabBar，不能用 wx.switchTab：${path.relative(root, file)}`);
}

const files = walk(src);
for (const file of files) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    try { JSON.parse(text); } catch (error) { problems.push(`JSON 解析失败：${rel}：${error.message}`); }
  }
  if (/\.(wxss|wxml)$/.test(file) && /gradient\s*\(/i.test(text)) problems.push(`出现渐变：${rel}`);
  if (/appsecret\s*[:=]\s*['"][0-9a-f]{32}['"]/i.test(text)) problems.push(`疑似写入了 AppSecret：${rel}`);
}

// 图标：所有引用的 SVG 都已生成；标签栏图标为 81×81 PNG 且小于 40KB
for (const file of files) {
  if (!/\.(wxml|ts|json)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\/assets\/icons\/[a-z0-9-]+\.svg/g)) {
    if (!fs.existsSync(path.join(src, match[0]))) problems.push(`缺少图标 ${match[0]}（先运行 npm run icons）：${path.relative(root, file)}`);
  }
}
// 错题本底栏图标：81×81 PNG 且小于 40KB
for (const name of ['home', 'notebook', 'review', 'me']) {
  for (const file of [`assets/tabbar/${name}.png`, `assets/tabbar/${name}-active.png`]) {
    const iconFile = path.join(src, file);
    if (!fs.existsSync(iconFile)) { problems.push(`底栏缺少图标：${file}`); continue; }
    const buf = fs.readFileSync(iconFile);
    const isPng = buf.subarray(1, 4).toString('ascii') === 'PNG';
    const width = isPng ? buf.readUInt32BE(16) : 0;
    const height = isPng ? buf.readUInt32BE(20) : 0;
    if (!isPng || width !== 81 || height !== 81) problems.push(`底栏图标须为 81×81 PNG：${file}`);
    if (buf.length >= 40 * 1024) problems.push(`底栏图标须小于 40KB：${file}`);
  }
}
// 包体：主包和每个分包都不超过 2MB，整包不超过 20MB（服务商代开发上限，比普通 30MB 更严）
const packageBytes = { main: 0 };
for (const file of files) {
  const rel = path.relative(src, file).split(path.sep).join('/');
  const pkg = subPackages.find((item) => rel.startsWith(`${item.root}/`));
  const key = pkg ? pkg.root : 'main';
  packageBytes[key] = (packageBytes[key] ?? 0) + fs.statSync(file).size;
}
for (const [key, bytes] of Object.entries(packageBytes)) {
  if (bytes > 2 * 1024 * 1024) problems.push(`${key === 'main' ? '主包' : `分包 ${key}`} 超过 2MB（${bytes} 字节）`);
}
const totalBytes = Object.values(packageBytes).reduce((sum, bytes) => sum + bytes, 0);
if (totalBytes > 20 * 1024 * 1024) problems.push(`整包超过 20MB（${totalBytes} 字节）`);
const assetBytes = walk(path.join(src, 'assets')).reduce((sum, file) => sum + fs.statSync(file).size, 0);
if (assetBytes > 200 * 1024) problems.push(`图片资源超过 200KB（${assetBytes} 字节），注意包体`);

const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
const config = fs.readFileSync(path.join(src, 'config.ts'), 'utf8');
const apiBase = /API_BASE_URL\s*=\s*'([^']+)'/.exec(config)?.[1] ?? '';
if (!apiBase.startsWith('https://')) problems.push('config.ts 的 API_BASE_URL 必须是 https:// 地址（微信只允许 HTTPS 合法域名）');

/** 用 TypeScript 转译后加载纯函数模块做冒烟测试 */
function loadModule(relPath) {
  const code = fs.readFileSync(path.join(src, relPath), 'utf8');
  // 目标 ES2015：与真机老版本基础库能跑的语法一致（例如不能用正则后行断言、\p{...}）
  const { outputText } = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2015 } });
  if (/\(\?<[!=]/.test(outputText)) problems.push(`${relPath} 用了正则后行断言，旧版 iOS 不支持`);
  const module = { exports: {} };
  const localRequire = (spec) => (spec.startsWith('.') ? loadModule(path.join(path.dirname(relPath), `${spec}.ts`)) : {});
  new Function('module', 'exports', 'require', outputText)(module, module.exports, localRequire);
  return module.exports;
}

const text = loadModule('utils/text.ts');
assert.equal(text.toPlainText('计算 $\\frac{1}{2} \\times 4$'), '计算 1/2 × 4');
assert.equal(text.toPlainText('**答案**：$x^{2}$'), '答案：x²');
assert.equal(text.toPlainText('$\\ce{2H2 + O2 -> 2H2O}$'), '2H₂ + O₂ → 2H₂O');
assert.equal(text.toPlainText('$\\ce{SO4^{2-}}$，$\\vec{F}$，$9.8\\,\\mathrm{m/s^2}$'), 'SO₄²⁻，向量F，9.8 m/s²');
assert.equal(text.toPlainText(null), '');
assert.deepEqual(text.parseKnowledgePoints('["分数","乘法"]'), ['分数', '乘法']);
assert.deepEqual(text.parseKnowledgePoints('分数，乘法'), ['分数', '乘法']);
assert.equal(text.formatDate('2026-11-25T08:00:00.000Z').length, 10);

const req = loadModule('utils/request.ts');
for (let i = 0; i < 20; i += 1) assert.match(req.newRequestId(), /^[a-f0-9]{32}$/);
assert.notEqual(req.newRequestId(), req.newRequestId());
// 多图识别：只有"没拿到响应"（网络超时 / 网关断开）才轮询结果，业务错误直接显示
assert.equal(req.isLostResponse({ errMsg: 'uploadFile:fail timeout' }), true);
assert.equal(req.isLostResponse(new req.ApiError(504, '')), true);
assert.equal(req.isLostResponse(new req.ApiError(502, '')), true);
assert.equal(req.isLostResponse(new req.ApiError(500, 'AI_TIMEOUT_ERROR')), false);
assert.equal(req.isLostResponse(new req.ApiError(429, 'AI_DAILY_LIMIT_EXCEEDED')), false);
assert.equal(req.toChineseMessage(new req.ApiError(429, 'AI_DAILY_LIMIT_EXCEEDED')), '今天的识别次数用完了，明天再来');

// 跨页题分组：编译到 ES2015 后仍可用
const groups = loadModule('utils/photo-groups.ts');
assert.deepEqual(groups.groupKeys([{ key: 'a', linkPrev: true }, { key: 'b', linkPrev: true }, { key: 'c', linkPrev: false }]), [['a', 'b'], ['c']]);
assert.equal(groups.mergedSize([{ key: 'a', linkPrev: false }, { key: 'b', linkPrev: true }, { key: 'c', linkPrev: false }], 2), 3);
assert.equal(groups.groupLabel([0, 1]), '1-2');

// 专注模式解锁键盘：最多 4 位；网络失败归为可重试
const kidLock = loadModule('utils/kid-lock.ts');
assert.equal(['1', '2', '3', '4', '5'].reduce(kidLock.pressPinKey, ''), '1234');
assert.equal(kidLock.classifyUnlockFailure({ errMsg: 'request:fail' }).kind, 'network');
assert.equal(kidLock.classifyUnlockFailure(new req.ApiError(403, 'PIN 码错误，还可尝试 4 次')).kind, 'wrong');

// 整页批改：三态与网页端一致，错误 / 部分正确进错题本
const paper = loadModule('utils/paper.ts');
assert.deepEqual(paper.VERDICTS, ['correct', 'partial', 'wrong']);
assert.deepEqual(paper.verdictPatch('partial'), { overrideVerdict: 'partial', selected: true });
assert.equal(paper.subjectKeyFromNotebookName('高中化学'), 'chemistry');

const share = loadModule('utils/share.ts');
const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
assert.equal(share.extractShareToken(`https://xueji.example.com/share/submission/${token}`), token);
assert.equal(share.extractShareToken(token), token);
assert.equal(share.extractShareToken('https://example.com/other'), null);

// 三合一跳转：错题本底栏切换不加深页面栈
const nav = loadModule('utils/nav.ts');
assert.deepEqual(nav.planTabSwitch(['pages/hub/hub', 'pkg-xueji/home/home'], '/pkg-xueji/notebook/notebook'), { kind: 'redirect' });
assert.deepEqual(nav.planTabSwitch(['pages/hub/hub', 'pkg-xueji/home/home', 'pkg-xueji/capture/capture'], '/pkg-xueji/notebook/notebook'), { kind: 'back', delta: 1, thenRedirect: true });
assert.deepEqual(nav.planTabSwitch(['pages/hub/hub', 'pkg-xueji/review/review', 'pkg-xueji/item/item'], '/pkg-xueji/review/review'), { kind: 'back', delta: 1, thenRedirect: false });
assert.deepEqual(nav.planTabSwitch(['pages/hub/hub'], '/pkg-xueji/review/review'), { kind: 'navigate' });

const words = loadModule('pkg-english/lib/words.ts');
assert.equal(words.artStem("o'clock"), 'o_clock');
assert.equal(words.artStem('a.m.'), 'a_m');
assert.equal(words.isCorrectSpelling(' Good  Morning ', 'good morning'), true);

const course = loadModule('pkg-math/lib/course.ts');
assert.equal(course.checkAnswer({ type: 'numeric', answer: '0.5' }, '1/2'), true);
assert.equal(course.checkAnswer({ type: 'numeric', answer: '28' }, '２８平方厘米'), true);
assert.equal(course.checkAnswer({ type: 'short', answer: '-3，-1/2', unordered: true }, '-1/2,-3'), true);
assert.equal(course.checkAnswer({ type: 'choice', answer: 'C' }, 'B'), false);

if (!/^wx[0-9a-f]{16}$/.test(projectConfig.appid) && projectConfig.appid !== 'touristappid') problems.push(`project.config.json 的 appid 格式不对：${projectConfig.appid}`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
const placeholder = projectConfig.appid === 'touristappid' || apiBase.includes('example.com');
console.log(`✓ ${allPages.length} 个页面（主包 ${app.pages.length} + ${subPackages.length} 个分包）、${files.length} 个文件检查通过；包体 ${Object.entries(packageBytes).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}KB`).join('、')}`);
if (placeholder) console.log('! 发布前请把 project.config.json 的 appid 和 src/config.ts 的 API_BASE_URL 改成正式值');
