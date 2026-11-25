#!/usr/bin/env node
/**
 * 小程序静态检查（无需微信开发者工具）：
 * 1. app.json 中每个页面都有 .ts / .wxml / .wxss / .json 四个文件，tabBar 页面都已注册；
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
for (const page of app.pages) {
  for (const ext of ['.ts', '.wxml', '.wxss', '.json']) {
    if (!fs.existsSync(path.join(src, `${page}${ext}`))) problems.push(`页面缺少文件：${page}${ext}`);
  }
}
for (const tab of app.tabBar?.list ?? []) {
  if (!app.pages.includes(tab.pagePath)) problems.push(`tabBar 页面未在 pages 中注册：${tab.pagePath}`);
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
for (const tab of app.tabBar?.list ?? []) {
  for (const key of ['iconPath', 'selectedIconPath']) {
    const iconFile = tab[key] ? path.join(src, tab[key]) : '';
    if (!iconFile || !fs.existsSync(iconFile)) { problems.push(`标签栏缺少图标：${tab.pagePath} ${key}`); continue; }
    const buf = fs.readFileSync(iconFile);
    const isPng = buf.subarray(1, 4).toString('ascii') === 'PNG';
    const width = isPng ? buf.readUInt32BE(16) : 0;
    const height = isPng ? buf.readUInt32BE(20) : 0;
    if (!isPng || width !== 81 || height !== 81) problems.push(`标签栏图标须为 81×81 PNG：${tab[key]}`);
    if (buf.length >= 40 * 1024) problems.push(`标签栏图标须小于 40KB：${tab[key]}`);
  }
}
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
assert.equal(text.toPlainText('$\\ce{SO4^{2-}}$，$\\vec{F}$，$9.8\\,\\mathrm{m/s^2}$'), 'SO₄²⁻，F⃗，9.8 m/s²');
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
assert.equal(req.toChineseMessage(new req.ApiError(429, 'AI_DAILY_LIMIT_EXCEEDED')), '今天的 AI 识别次数用完了，明天再来');

const share = loadModule('utils/share.ts');
const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';
assert.equal(share.extractShareToken(`https://xueji.example.com/share/submission/${token}`), token);
assert.equal(share.extractShareToken(token), token);
assert.equal(share.extractShareToken('https://example.com/other'), null);

if (!/^wx[0-9a-f]{16}$/.test(projectConfig.appid) && projectConfig.appid !== 'touristappid') problems.push(`project.config.json 的 appid 格式不对：${projectConfig.appid}`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
const placeholder = projectConfig.appid === 'touristappid' || apiBase.includes('example.com');
console.log(`✓ ${app.pages.length} 个页面、${files.length} 个文件检查通过`);
if (placeholder) console.log('! 发布前请把 project.config.json 的 appid 和 src/config.ts 的 API_BASE_URL 改成正式值');
