/**
 * 拼单词：看中文（或听发音）拼写；拼错两次亮出答案，照着拼对才能继续。
 * 第一次就拼对的词升一盒，错过的词回到 0 盒当天再复习；一关结束可把错词收进学迹错题本。
 */
import { ENGLISH_DEFAULTS, readModule, writeModule } from '../../utils/module-store';
import { loadRemoteJson } from '../../utils/remote-data';
import { toChineseMessage } from '../../utils/request';
import { speak, stopSpeaking } from '../../utils/speech';
import { SHOW_SYNTH_MEDIA } from '../../config';
import { addToNotebook, isKidMode } from '../../utils/to-notebook';
import { dictUrl, dueWords, findBook, isCorrectSpelling, letterMarks, levelCount, levelWords, scheduleWord, starsFor, toWords, wordToNotebook } from '../lib/words';
import type { LetterMark, RawWord, Word } from '../lib/words';

interface ResultRow { name: string; trans: string; ok: boolean }

let advanceTimer: number | null = null;

Page({
  data: {
    loading: true,
    error: '',
    review: false,
    bookId: '',
    level: 0,
    levelTotal: 0,
    dictation: false,
    speech: SHOW_SYNTH_MEDIA,
    words: [] as Word[],
    index: 0,
    word: null as Word | null,
    typed: '',
    marks: [] as { ch: string; mark: LetterMark }[],
    attempts: 0,
    hinted: false,
    revealed: false,
    solved: false,
    shake: false,
    focus: true,
    results: [] as ResultRow[],
    done: false,
    stars: 0,
    starText: '',
    wrongCount: 0,
    kidMode: false,
    saving: false,
    saved: false,
  },

  async onLoad(query: Record<string, string | undefined>) {
    const store = readModule('english', ENGLISH_DEFAULTS);
    const review = query.review === '1';
    this.setData({ review, dictation: SHOW_SYNTH_MEDIA && store.mode === 'dictation', kidMode: isKidMode() });
    if (review) {
      wx.setNavigationBarTitle({ title: '今日复习' });
      this.start(dueWords(store.words, Date.now()));
      return;
    }
    const book = findBook(decodeURIComponent(query.book || store.book));
    const level = Math.max(0, Number(query.level) || 0);
    this.setData({ bookId: book.id, level });
    wx.setNavigationBarTitle({ title: `${book.label} · 第 ${level + 1} 关` });
    try {
      const all = toWords(await loadRemoteJson<RawWord[]>(`en-${book.id}`, dictUrl(book), 7 * 24 * 60 * 60 * 1000));
      this.setData({ levelTotal: levelCount(all.length) });
      this.start(levelWords(all, level));
    } catch (error) {
      this.setData({ loading: false, error: toChineseMessage(error) });
    }
  },

  onUnload() {
    if (advanceTimer) clearTimeout(advanceTimer);
    stopSpeaking();
  },

  start(words: Word[]) {
    this.setData({ loading: false, words, results: [], done: false, saved: false, wrongCount: 0 });
    if (words.length === 0) {
      this.setData({ error: this.data.review ? '今天没有要复习的词' : '这一关没有单词' });
      return;
    }
    this.show(0);
  },

  show(index: number) {
    const word = this.data.words[index];
    this.setData({
      index, word, typed: '', marks: letterMarks('', word.name),
      attempts: 0, hinted: false, revealed: false, solved: false, focus: true,
    });
    if (this.data.dictation) void this.play();
  },

  async play() {
    const word = this.data.word;
    if (!word || !SHOW_SYNTH_MEDIA) return;
    const ok = await speak(word.name, 'en');
    if (!ok) wx.showToast({ title: '发音暂时不可用', icon: 'none' });
  },

  onInput(e: WechatMiniprogram.Input) {
    if (this.data.solved || !this.data.word) return;
    const typed = e.detail.value;
    const target = this.data.word.name;
    this.setData({ typed, marks: letterMarks(typed, target) });
    if (typed.length >= target.length) this.judge(typed);
  },

  onConfirm() {
    if (!this.data.solved && this.data.typed) this.judge(this.data.typed);
  },

  judge(typed: string) {
    const word = this.data.word;
    if (!word) return;
    if (isCorrectSpelling(typed, word.name)) {
      this.solve(typed);
      return;
    }
    const attempts = this.data.attempts + 1;
    if (attempts === 1) this.record(false, typed);
    this.setData({ attempts, revealed: this.data.revealed || attempts >= 2, shake: true });
    setTimeout(() => this.setData({ shake: false, typed: '', marks: letterMarks('', word.name) }), 600);
  },

  /** 记一次结果（每个词只记第一次：拼错或首次拼对） */
  record(correct: boolean, typed: string) {
    const word = this.data.word;
    if (!word) return;
    const store = readModule('english', ENGLISH_DEFAULTS);
    store.words = { ...store.words, [word.name]: scheduleWord(store.words[word.name], correct, word, this.data.bookId || 'review', Date.now(), typed) };
    writeModule('english', store);
    const results = this.data.results.concat({ name: word.name, trans: word.trans, ok: correct });
    this.setData({ results, wrongCount: this.data.wrongCount + (correct ? 0 : 1) });
  },

  solve(typed: string) {
    const clean = this.data.attempts === 0 && !this.data.hinted && !this.data.revealed;
    if (clean) this.record(true, typed);
    else if (this.data.attempts === 0) this.record(false, '（看了提示）');
    this.setData({ solved: true, focus: false });
    void this.play();
    advanceTimer = setTimeout(() => this.next(), 1400) as unknown as number;
  },

  onHint() {
    const word = this.data.word;
    if (!word || this.data.solved) return;
    // 提示：保留已拼对的部分，再补一个字母
    let correctPrefix = 0;
    while (correctPrefix < this.data.typed.length && this.data.typed[correctPrefix].toLowerCase() === word.name[correctPrefix].toLowerCase()) correctPrefix += 1;
    const next = word.name.slice(0, Math.min(word.name.length, correctPrefix + 1));
    this.setData({ hinted: true, typed: next, marks: letterMarks(next, word.name), focus: true });
    if (next.length >= word.name.length) this.judge(next);
  },

  onReveal() {
    this.setData({ revealed: true, focus: true });
  },

  onSkip() {
    if (this.data.solved) return;
    if (this.data.attempts === 0) this.record(false, '');
    this.next();
  },

  next() {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
    const index = this.data.index + 1;
    if (index < this.data.words.length) {
      this.show(index);
      return;
    }
    this.finish();
  },

  finish() {
    const stars = starsFor(this.data.wrongCount);
    if (!this.data.review && this.data.bookId) {
      const store = readModule('english', ENGLISH_DEFAULTS);
      const bookLevels = { ...(store.levels[this.data.bookId] || {}) };
      bookLevels[String(this.data.level)] = Math.max(bookLevels[String(this.data.level)] || 0, stars);
      store.levels = { ...store.levels, [this.data.bookId]: bookLevels };
      writeModule('english', store);
    }
    this.setData({ done: true, stars, starText: '★'.repeat(stars) + '☆'.repeat(3 - stars), focus: false });
  },

  async onSaveWrong() {
    const store = readModule('english', ENGLISH_DEFAULTS);
    const drafts = this.data.results.filter((row) => !row.ok && store.words[row.name]).map((row) => ({
      subjectName: '英语' as const,
      ...wordToNotebook(row.name, store.words[row.name]),
      knowledgePoints: ['单词拼写'],
    }));
    if (drafts.length === 0) return;
    this.setData({ saving: true });
    try {
      const res = await addToNotebook(drafts);
      this.setData({ saved: true });
      wx.showToast({ title: res.duplicated ? `已收 ${res.added} 个，${res.duplicated} 个之前收过` : `已收进错题本 ${res.added} 个`, icon: 'none' });
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onAgain() {
    this.start(this.data.words);
  },

  onNextLevel() {
    wx.redirectTo({ url: `/pkg-english/practice/practice?book=${encodeURIComponent(this.data.bookId)}&level=${this.data.level + 1}` });
  },

  onBack() {
    wx.navigateBack();
  },
});
