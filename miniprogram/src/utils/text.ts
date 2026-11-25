/**
 * 题目、解析在后端是 Markdown + LaTeX。第一期小程序不内置公式渲染引擎，
 * 这里把常见写法转成可读的纯文本；复杂公式（矩阵、多行对齐）建议在网页端查看。
 */
const SYMBOLS: Array<[RegExp, string]> = [
  [/\\times/g, '×'], [/\\div/g, '÷'], [/\\cdot/g, '·'], [/\\pm/g, '±'],
  [/\\leq?/g, '≤'], [/\\geq?/g, '≥'], [/\\neq/g, '≠'], [/\\approx/g, '≈'],
  [/\\infty/g, '∞'], [/\\pi/g, 'π'], [/\\alpha/g, 'α'], [/\\beta/g, 'β'],
  [/\\theta/g, 'θ'], [/\\angle/g, '∠'], [/\\triangle/g, '△'], [/\\degree|\^\{?\\circ\}?/g, '°'],
  [/\\perp/g, '⊥'], [/\\parallel/g, '∥'], [/\\because/g, '∵'], [/\\therefore/g, '∴'],
  [/\\rightarrow|\\to/g, '→'], [/\\Rightarrow/g, '⇒'], [/\\in/g, '∈'], [/\\cup/g, '∪'], [/\\cap/g, '∩'],
];

export function toPlainText(input: string | null | undefined): string {
  if (!input) return '';
  let text = String(input);
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, '$1').replace(/\$([^$]*?)\$/g, '$1');
  text = text.replace(/\\\(|\\\)|\\\[|\\\]/g, '');
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
    text = text.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
  }
  for (const [pattern, symbol] of SYMBOLS) text = text.replace(pattern, symbol);
  text = text.replace(/\\(?:text|mathrm|mathbf|boxed|overline|underline)\{([^{}]*)\}/g, '$1');
  text = text.replace(/\^\{([^{}]*)\}/g, '^$1').replace(/_\{([^{}]*)\}/g, '_$1');
  text = text.replace(/\\left|\\right|\\quad|\\qquad|\\,|\\;|\\!/g, ' ');
  text = text.replace(/\\\\/g, '\n');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  text = text.replace(/^#{1,6}\s*/gm, '').replace(/^>\s?/gm, '');
  text = text.replace(/<[^>]+>/g, '');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
