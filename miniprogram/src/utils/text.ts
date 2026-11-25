import { latexToPlainText } from './latex';

/**
 * 题目、解析在后端是 Markdown + LaTeX（含化学 \ce、单位 \pu）。小程序没有 KaTeX，
 * 由 latex.ts 转成 Unicode 文本（上下标、希腊字母、化学式、反应箭头等），各学科通用。
 */
export function toPlainText(input: string | null | undefined): string {
  return latexToPlainText(input);
}

export function parseKnowledgePoints(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
  } catch {
    // 旧数据可能是逗号分隔
  }
  return raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

export const MASTERY_LABEL: Record<string, string> = {
  new: '待复习',
  reviewing: '复习中',
  mastered: '已掌握',
};

/** 掌握情况徽标图标（颜色与 .badge-* 一致） */
export const MASTERY_ICON: Record<string, string> = {
  new: '/assets/icons/circle-dot-o.svg',
  reviewing: '/assets/icons/refresh-cw-p.svg',
  mastered: '/assets/icons/circle-check-s.svg',
};

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
