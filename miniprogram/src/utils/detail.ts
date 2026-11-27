/**
 * 原生「查看详情」：错题详情（做题记录、复习计划、笔记）与整页批改的每题详情。
 * 本文件只放纯逻辑与小工具，便于单测；页面在 pkg-xueji/detail、pkg-xueji/question。
 */
import { formatDate, toPlainText } from './text';

export interface PracticeRecordRow {
  id: string;
  result: string | null;
  source: string | null;
  createdAt: string;
  exam?: { title: string | null } | null;
}

export interface PracticeRecordsResponse {
  masteryProbability?: number | null;
  masteryStatus?: string;
  records: PracticeRecordRow[];
}

export interface LearningContext {
  nextReviewAt: string | null;
  reviewDue: boolean;
  knowledgeMastery: Array<{ knowledgePoint: string; score: number; evidenceCount: number }>;
}

export const RESULT_META: Record<string, { label: string; icon: string; cls: string }> = {
  correct: { label: '对了', icon: '/assets/icons/check-s.svg', cls: 'r-ok' },
  wrong: { label: '错了', icon: '/assets/icons/x-d.svg', cls: 'r-bad' },
  not_attempted: { label: '不会', icon: '/assets/icons/circle-help-o.svg', cls: 'r-idk' },
};

export const SOURCE_LABEL: Record<string, string> = {
  manual: '自己标记',
  practice: '练习',
  exam: '试卷',
  duplicate_import: '重复录入',
};

export interface HistoryRow {
  id: string;
  date: string;
  label: string;
  icon: string;
  cls: string;
  source: string;
}

/** 做题记录：新的在前，最多显示 limit 条 */
export function toHistory(records: PracticeRecordRow[] | null | undefined, limit = 30): HistoryRow[] {
  return (records || [])
    .filter((record) => record.result && RESULT_META[record.result])
    .slice(0, limit)
    .map((record) => {
      const meta = RESULT_META[record.result as string];
      const source = record.exam && record.exam.title ? record.exam.title : SOURCE_LABEL[record.source || ''] || '';
      return { id: record.id, date: formatDate(record.createdAt), label: meta.label, icon: meta.icon, cls: meta.cls, source };
    });
}

export function percent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

export interface PlanView {
  next: string;
  due: boolean;
  kps: Array<{ name: string; pct: number }>;
}

export function toPlan(learning: LearningContext | null | undefined): PlanView | null {
  if (!learning) return null;
  const kps = (learning.knowledgeMastery || []).map((row) => ({ name: row.knowledgePoint, pct: percent(row.score) }));
  const next = learning.nextReviewAt ? formatDate(learning.nextReviewAt) : '';
  if (!next && !kps.length) return null;
  return { next, due: Boolean(learning.reviewDue), kps };
}

/** 年级 · 来源 · 难度，空的不显示 */
export function metaLine(item: { gradeSemester?: string | null; source?: string | null; paperLevel?: string | null }): string {
  return [item.gradeSemester, item.source, item.paperLevel ? `${item.paperLevel} 卷` : ''].map((part) => toPlainText(part || '')).filter(Boolean).join(' · ');
}

export function stars(value: number | null | undefined): number[] {
  return typeof value === 'number' && value >= 1 && value <= 5 ? Array.from({ length: Math.round(value) }, (_, i) => i) : [];
}

/** UTF-8 字符串转 base64（小程序没有 btoa / Buffer） */
export function utf8ToBase64(input: string): string {
  const bytes: number[] = [];
  for (const char of input) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else { bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63)); }
  }
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += table[a >> 2] + table[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : table[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : table[c & 63];
  }
  return out;
}

/** 服务端已净化的配图 SVG → 可直接给 <image> 的 data URL；不像 SVG 的不显示 */
export function figureDataUrl(svg: string | null | undefined): string {
  if (!svg || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return '';
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
}

/** 只显示站内能直接给 <image> 的图片地址 */
export function safeImage(url: string | null | undefined): string {
  return url && /^(data:image\/(png|jpe?g|webp|gif);base64,|https:\/\/)/.test(url) ? url : '';
}

let lastPreview = '';

/** 放大看图：https 直接预览；data URL 先写成临时文件（wx.previewImage 不收 data URL） */
export function previewImage(url: string): void {
  if (!url) return;
  if (url.startsWith('https://')) {
    wx.previewImage({ urls: [url] });
    return;
  }
  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(url);
  if (!match) return;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filePath = `${wx.env.USER_DATA_PATH}/xj-preview-${Date.now()}.${ext}`;
  const fs = wx.getFileSystemManager();
  // 只留最近一张，避免用户目录越积越多
  if (lastPreview) fs.unlink({ filePath: lastPreview, fail: () => undefined });
  lastPreview = filePath;
  fs.writeFile({
    filePath,
    data: match[2],
    encoding: 'base64',
    success: () => wx.previewImage({ urls: [filePath] }),
    fail: () => wx.showToast({ title: '图片打不开', icon: 'none' }),
  });
}

/** 题目详情页改了判定：回到批改页时刷新 */
let changedPaperId = '';
export function markPaperChanged(paperId: string): void {
  changedPaperId = paperId;
}
export function takePaperChanged(paperId: string): boolean {
  const changed = Boolean(paperId) && changedPaperId === paperId;
  if (changed) changedPaperId = '';
  return changed;
}
