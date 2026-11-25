#!/usr/bin/env node
/**
 * 按需生成小程序图标：扫描 src 下 wxml/ts/json 中引用的 /assets/icons/<名称>-<颜色>.svg，
 * 从 icons/lucide/<名称>.svg（Lucide，ISC 许可）生成单色 SVG。只写用到的文件，并删除不再引用的旧文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const outDir = path.join(src, 'assets', 'icons');
const sourceDir = path.join(root, 'icons', 'lucide');

/** 颜色代号：与 app.wxss 的薰衣草紫配色一致 */
export const ICON_COLORS = {
  p: '#6B5CA5', // 主色
  w: '#FFFFFF', // 白（主色按钮上）
  m: '#8A8499', // 次要文字
  l: '#B7AEDB', // 浅紫（空状态插画）
  a: '#4A3D7A', // 深紫
  s: '#008C4D', // 成功
  d: '#A60028', // 危险
  o: '#D88000', // 提醒
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function collectIconRefs() {
  const refs = new Set();
  for (const file of walk(src)) {
    if (!/\.(wxml|ts|json)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\/assets\/icons\/([a-z0-9-]+)-([a-z])\.svg/g)) refs.add(`${match[1]}|${match[2]}`);
  }
  return refs;
}

export function renderIcon(name, colorKey) {
  const color = ICON_COLORS[colorKey];
  if (!color) throw new Error(`未知颜色代号 ${colorKey}（${name}）`);
  const file = path.join(sourceDir, `${name}.svg`);
  if (!fs.existsSync(file)) throw new Error(`缺少图标源文件 icons/lucide/${name}.svg`);
  const raw = fs.readFileSync(file, 'utf8');
  const body = raw.slice(raw.indexOf('>', raw.indexOf('<svg')) + 1, raw.lastIndexOf('</svg>'))
    .replace(/\s*\n\s*/g, '').trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(outDir, { recursive: true });
  const refs = collectIconRefs();
  const wanted = new Set();
  for (const ref of refs) {
    const [name, colorKey] = ref.split('|');
    const fileName = `${name}-${colorKey}.svg`;
    wanted.add(fileName);
    fs.writeFileSync(path.join(outDir, fileName), renderIcon(name, colorKey));
  }
  for (const existing of fs.readdirSync(outDir)) {
    if (existing.endsWith('.svg') && !wanted.has(existing)) fs.unlinkSync(path.join(outDir, existing));
  }
  console.log(`✓ 生成 ${wanted.size} 个图标`);
}
