/**
 * 学英语的纯逻辑（不依赖 wx，可单测）：词书、插图、拼写判定、间隔复习。
 * 词表与插图来自敲敲乐站点 lingo.jjool.com 的公开数据文件；这里的代码是为小程序重新写的，没有拷贝敲敲乐源码。
 */
import type { WordState } from '../../utils/module-store';
import { ART_STEMS } from './art-stems';

export const LINGO_BASE = 'https://lingo.jjool.com';
export const LEVEL_SIZE = 10;

export interface Book { id: string; label: string; path: string }

const GRADES = ['一', '二', '三', '四', '五', '六'];
export const BOOKS: Book[] = [
  ...GRADES.flatMap((cn, index) => ['上', '下'].map((term) => ({
    id: `grade_${index + 1}${term}`,
    label: `${cn}${term}`,
    path: `/dicts/grades/grade_${index + 1}${term}.json`,
  }))),
  { id: 'zhongkao', label: '中考', path: '/dicts/shanghai_zhongkao.json' },
];

export function findBook(id: string): Book {
  return BOOKS.find((book) => book.id === id) || BOOKS[4];
}

export function dictUrl(book: Book): string {
  return LINGO_BASE + encodeURI(book.path);
}

export interface RawWord { name: string; trans?: string[]; usphone?: string; ukphone?: string; sentence?: string; sentenceTrans?: string }

export interface Word { name: string; trans: string; phone: string; sentence: string; sentenceTrans: string; art: string }

let stemSet: Set<string> | null = null;

/** 插图文件名：小写，非字母数字（保留连字符）换成下划线，去掉首尾下划线，如 a.m. → a_m、o'clock → o_clock */
export function artStem(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
}

export function artUrl(name: string): string {
  if (!stemSet) stemSet = new Set(ART_STEMS.split('|'));
  const stem = artStem(name);
  return stemSet.has(stem) ? `${LINGO_BASE}/word-art/still/${stem}.webp` : '';
}

export function toWord(raw: RawWord): Word {
  return {
    name: String(raw.name || '').trim(),
    trans: (raw.trans || []).join('；'),
    phone: raw.usphone || raw.ukphone || '',
    sentence: raw.sentence || '',
    sentenceTrans: raw.sentenceTrans || '',
    art: artUrl(String(raw.name || '')),
  };
}

export function toWords(raws: RawWord[]): Word[] {
  return raws.filter((raw) => raw && typeof raw.name === 'string' && raw.name.trim()).map(toWord);
}

export function levelCount(total: number): number {
  return Math.ceil(total / LEVEL_SIZE);
}

export function levelWords<T>(words: T[], level: number): T[] {
  return words.slice(level * LEVEL_SIZE, (level + 1) * LEVEL_SIZE);
}

/** 比较时忽略大小写、多余空格和弯引号 */
export function normalizeSpelling(text: string): string {
  return text.replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isCorrectSpelling(typed: string, word: string): boolean {
  return normalizeSpelling(typed) === normalizeSpelling(word);
}

export type LetterMark = 'ok' | 'bad' | 'empty' | 'space';

/** 每个字母位置的提示：已输入的对 / 错，没输入的空着 */
export function letterMarks(typed: string, word: string): { ch: string; mark: LetterMark }[] {
  const t = typed.replace(/[’‘`]/g, "'");
  return Array.from(word).map((ch, index) => {
    const typedCh = t[index];
    if (ch === ' ') return typedCh === undefined || typedCh === ' ' ? { ch: ' ', mark: 'space' as LetterMark } : { ch: typedCh, mark: 'bad' as LetterMark };
    if (typedCh === undefined) return { ch: '', mark: 'empty' as LetterMark };
    return { ch: typedCh, mark: (typedCh.toLowerCase() === ch.toLowerCase() ? 'ok' : 'bad') as LetterMark };
  });
}

/** 间隔复习：答对升一盒，答错回到 0 盒、当天再复习 */
export const INTERVAL_DAYS = [0, 1, 2, 4, 7, 15];
const DAY = 24 * 60 * 60 * 1000;

export function scheduleWord(prev: WordState | undefined, correct: boolean, word: Word, bookId: string, now: number, wrongSpelling = ''): WordState {
  const box = correct ? Math.min((prev ? prev.b : 0) + 1, INTERVAL_DAYS.length - 1) : 0;
  return {
    b: box,
    d: now + INTERVAL_DAYS[box] * DAY,
    w: (prev ? prev.w : 0) + (correct ? 0 : 1),
    t: word.trans.slice(0, 40),
    p: word.phone.slice(0, 40),
    k: prev ? prev.k : bookId,
    ...(correct ? (prev && prev.x ? { x: prev.x } : {}) : { x: wrongSpelling.slice(0, 40) }),
  };
}

export function starsFor(wrong: number): number {
  if (wrong === 0) return 3;
  if (wrong <= 2) return 2;
  return 1;
}

/** 复习单：已到期的词，按到期时间排序，最多 limit 个 */
export function dueWords(words: Record<string, WordState>, now: number, limit = 20): Word[] {
  return Object.entries(words)
    .filter(([, state]) => state.d <= now)
    .sort((a, b) => a[1].d - b[1].d)
    .slice(0, limit)
    .map(([name, state]) => ({ name, trans: state.t, phone: state.p, sentence: '', sentenceTrans: '', art: artUrl(name) }));
}

/** 收进错题本时的题面 */
export function wordToNotebook(name: string, state: WordState): { questionText: string; answerText: string; wrongAnswerText: string } {
  return {
    questionText: `写出单词：${state.t}${state.p ? `（/${state.p}/）` : ''}`,
    answerText: name,
    wrongAnswerText: state.x || '',
  };
}
