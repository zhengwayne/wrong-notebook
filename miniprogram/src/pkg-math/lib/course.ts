/**
 * 学数学的纯逻辑（不依赖 wx，可单测）：课程路线分站、选题、判题、徽章。
 * 数据来自数学星图站点 math.jjool.com 的公开 JSON；知识图谱 cn-math-taxonomy 采用 CC BY-NC 4.0，
 * 因此本模块免费、非商业，并在页面底部署名。
 */
export const MATH_BASE = 'https://math.jjool.com';
export const ATTRIBUTION = '知识图谱：cn-math-taxonomy（CC BY-NC 4.0）· 免费、非商业';

export interface KNode { id: string; name: string; grade?: number; semester?: string; domain?: string; chapter?: string; description?: string; mastery?: string[]; lessons?: string[] }
export interface Lesson { id: string; book: string; bookSlug: string; no: number; title: string; nodes: string[]; primary?: string; prereqNodes?: string[] }
export interface Course { nodes: KNode[]; lessons: Lesson[]; path: string[]; pathMeta: Record<string, { g: number; s: string; ch: string }> }
export interface Choice { key: string; text: string }
export interface Question { id: string; topicId: string; type: 'numeric' | 'choice' | 'short' | 'self'; prompt: string; answer: string; explanation?: string; choices?: Choice[]; accept?: string[]; unordered?: boolean; difficulty?: string }

const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export interface Camp { key: string; label: string }
export interface Station { id: string; title: string; chapter: string; book: string }
export interface ChapterGroup { chapter: string; stations: Station[] }

/** 分站：小学合成一站；初中按年级上下册 */
export function campKey(meta: { g: number; s: string } | undefined): string {
  if (!meta || meta.g <= 6) return 'p';
  return `${meta.g}${meta.s || '上'}`;
}

export function campLabel(key: string): string {
  if (key === 'p') return '小学';
  return `${CN[Number(key[0])] || key[0]}${key.slice(1)}`;
}

export function listCamps(course: Course): Camp[] {
  const keys: string[] = [];
  for (const id of course.path) {
    const key = campKey(course.pathMeta[id]);
    if (!keys.includes(key)) keys.push(key);
  }
  const order = (k: string) => (k === 'p' ? 0 : Number(k[0]) * 2 + (k[1] === '下' ? 1 : 0));
  return keys.sort((a, b) => order(a) - order(b)).map((key) => ({ key, label: campLabel(key) }));
}

export function lessonMap(course: Course): Map<string, Lesson> {
  return new Map(course.lessons.map((lesson) => [lesson.id, lesson]));
}

export function nodeMap(course: Course): Map<string, KNode> {
  return new Map(course.nodes.map((node) => [node.id, node]));
}

/** 某一站的课，按路线顺序、按章节分组 */
export function campChapters(course: Course, key: string): ChapterGroup[] {
  const lessons = lessonMap(course);
  const groups: ChapterGroup[] = [];
  for (const id of course.path) {
    const meta = course.pathMeta[id];
    if (campKey(meta) !== key) continue;
    const lesson = lessons.get(id);
    if (!lesson) continue;
    const chapter = (meta && meta.ch) || lesson.book;
    let group = groups[groups.length - 1];
    if (!group || group.chapter !== chapter) {
      group = { chapter, stations: [] };
      groups.push(group);
    }
    group.stations.push({ id, title: lesson.title, chapter, book: lesson.book });
  }
  return groups;
}

export function heroUrl(lessonId: string, art: string[], enabled = false): string {
  if (!enabled) return '';
  const path = `img/lessons/${lessonId}-hero.webp`;
  return art.includes(path) ? `${MATH_BASE}/${path}` : '';
}

/** 一课的闯关题：先用按课编写的题，不够再从这课知识点的题库补，最多 limit 道 */
export function pickQuestions(lesson: Lesson, kpQuiz: Record<string, Question[]>, bank: Question[], limit = 8, random: () => number = Math.random): Question[] {
  const own = (kpQuiz[lesson.id] || []).slice();
  const ids = new Set(own.map((q) => q.id));
  const extra = bank.filter((q) => lesson.nodes.includes(q.topicId) && !ids.has(q.id) && q.type !== 'self');
  const shuffle = (list: Question[]) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  return shuffle(own).concat(shuffle(extra)).slice(0, limit);
}

/* ---------- 判题 ---------- */

function halfWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
}

/** 规范化：全角转半角，去空格和单位符号，统一分隔符和负号 */
export function normalizeAnswer(text: string): string {
  return halfWidth(String(text))
    .replace(/[−—–]/g, '-')
    .replace(/[，、；;]/g, ',')
    .replace(/[×]/g, '*')
    .replace(/[·]/g, '*')
    .replace(/℃|°c/gi, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 数值：整数、小数、分数（含带分数 1又1/2 写作 1+1/2 不支持）、百分数 */
export function numberValue(text: string): number | null {
  const t = text.replace(/^\+/, '');
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d+(\.\d+)?%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  const frac = /^(-?)(\d+)\/(\d+)$/.exec(t);
  if (frac && Number(frac[3]) !== 0) return (frac[1] ? -1 : 1) * Number(frac[2]) / Number(frac[3]);
  return null;
}

function sameAtom(a: string, b: string): boolean {
  if (a === b) return true;
  const x = numberValue(a);
  const y = numberValue(b);
  return x !== null && y !== null && Math.abs(x - y) < 1e-9;
}

/** 去掉末尾的中文单位（如“28平方厘米”“5个”），只在标准答案是纯数时用 */
function stripUnit(text: string): string {
  const match = /^(-?[\d.\/%]+)[\u4e00-\u9fa5a-z²³]*$/.exec(text);
  return match ? match[1] : text;
}

export function checkAnswer(q: Question, input: string): boolean {
  if (q.type === 'choice') return halfWidth(input).trim().toUpperCase() === q.answer.trim().toUpperCase();
  const given = normalizeAnswer(input);
  if (!given) return false;
  const candidates = [q.answer, ...(q.accept || [])].map(normalizeAnswer);
  return candidates.some((cand) => {
    const g = numberValue(cand) !== null ? stripUnit(given) : given;
    if (sameAtom(cand, g)) return true;
    const want = cand.split(',').filter(Boolean);
    const got = g.split(',').filter(Boolean);
    if (want.length < 2 || want.length !== got.length) return false;
    if (q.unordered) {
      const used = new Set<number>();
      return got.every((item) => {
        const index = want.findIndex((w, i) => !used.has(i) && sameAtom(w, item));
        if (index < 0) return false;
        used.add(index);
        return true;
      });
    }
    return want.every((w, i) => sameAtom(w, got[i]));
  });
}

export function scorePercent(correct: number, total: number): number {
  return total ? Math.round((correct * 100) / total) : 0;
}

/** 收进错题本时的题面（选择题把选项也写进去） */
export function questionToNotebook(q: Question): { questionText: string; answerText: string } {
  const choices = (q.choices || []).map((c) => `${c.key}. ${c.text}`).join('\n');
  const answerChoice = (q.choices || []).find((c) => c.key === q.answer);
  return {
    questionText: choices ? `${q.prompt}\n${choices}` : q.prompt,
    answerText: answerChoice ? `${q.answer}. ${answerChoice.text}` : q.answer,
  };
}

/* ---------- 徽章 ---------- */

export interface Badge { id: string; name: string; hint: string; img: string; got: boolean }

const BOOK_BADGES: { id: string; slug: string; name: string }[] = [
  { id: 'rational', slug: 'sys', name: '数与式' },
  { id: 'equation', slug: 'fch', name: '方程与函数' },
  { id: 'geometry', slug: 'geo', name: '图形与几何' },
  { id: 'stats', slug: 'sta', name: '统计与概率' },
  { id: 'ss', slug: 'ss', name: '算术' },
  { id: 'nt', slug: 'nt', name: '数论' },
  { id: 'og', slug: 'og', name: '奥数平面几何' },
];

export function computeBadges(course: Course, best: Record<string, number>, perfect: number, pass = 80): Badge[] {
  const lit = new Set(Object.keys(best).filter((id) => best[id] >= pass));
  const lessons = course.lessons.filter((lesson) => course.path.includes(lesson.id));
  const books = new Set(lessons.filter((lesson) => lit.has(lesson.id)).map((lesson) => lesson.bookSlug));
  const img = (name: string) => `${MATH_BASE}/img/badges/badge-${name}.webp`;
  const list: Badge[] = [
    { id: 'first-star', name: '第一颗星', hint: '点亮 1 课', img: img('first-star'), got: lit.size >= 1 },
    { id: 'lesson5', name: '五课连亮', hint: '点亮 5 课', img: img('lesson5'), got: lit.size >= 5 },
    { id: 'quiz-perfect', name: '满分闯关', hint: '一次闯关全对', img: img('quiz-perfect'), got: perfect >= 1 },
    { id: 'explorer', name: '探索家', hint: '在 3 本书里各点亮一课', img: img('explorer'), got: books.size >= 3 },
  ];
  for (const book of BOOK_BADGES) {
    const inBook = lessons.filter((lesson) => lesson.bookSlug === book.slug);
    if (inBook.length === 0) continue;
    list.push({ id: book.id, name: book.name, hint: `点亮「${book.name}」全部 ${inBook.length} 课`, img: img(book.id), got: inBook.every((lesson) => lit.has(lesson.id)) });
  }
  list.push({ id: 'all', name: '星图全亮', hint: `点亮全部 ${lessons.length} 课`, img: img('all'), got: lessons.length > 0 && lessons.every((lesson) => lit.has(lesson.id)) });
  return list;
}
