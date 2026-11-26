/** 学英语首页：选词书 → 选关卡（每关 10 词）；到期的词进「今日复习」。 */
import { loadContext } from '../../utils/context';
import { ENGLISH_DEFAULTS, englishDueCount, readModule, writeModule } from '../../utils/module-store';
import type { EnglishStore } from '../../utils/module-store';
import { loadRemoteJson } from '../../utils/remote-data';
import { toChineseMessage } from '../../utils/request';
import { BOOKS, dictUrl, findBook, levelCount } from '../lib/words';
import type { RawWord } from '../lib/words';

interface LevelCell { index: number; label: string; stars: number; starText: string }

Page({
  data: {
    books: BOOKS.map((book) => ({ id: book.id, label: book.label })),
    bookId: ENGLISH_DEFAULTS.book,
    mode: 'spell' as EnglishStore['mode'],
    levels: [] as LevelCell[],
    total: 0,
    due: 0,
    learned: 0,
    loading: true,
    error: '',
  },

  async onShow() {
    const ctx = await loadContext().catch((error) => { this.setData({ error: toChineseMessage(error) }); return null; });
    if (!ctx) return;
    const store = readModule('english', ENGLISH_DEFAULTS);
    this.setData({
      bookId: findBook(store.book).id,
      mode: store.mode,
      due: englishDueCount(store),
      learned: Object.keys(store.words).length,
    });
    await this.loadBook();
  },

  async loadBook() {
    const book = findBook(this.data.bookId);
    this.setData({ loading: true, error: '' });
    try {
      const raws = await loadRemoteJson<RawWord[]>(`en-${book.id}`, dictUrl(book), 7 * 24 * 60 * 60 * 1000);
      const store = readModule('english', ENGLISH_DEFAULTS);
      const stars = store.levels[book.id] || {};
      const levels: LevelCell[] = Array.from({ length: levelCount(raws.length) }, (_, index) => {
        const value = stars[String(index)] || 0;
        return { index, label: String(index + 1), stars: value, starText: value ? '★'.repeat(value) : '' };
      });
      this.setData({ levels, total: raws.length, loading: false });
    } catch (error) {
      this.setData({ loading: false, error: toChineseMessage(error) });
    }
  },

  onPickBook(e: WechatMiniprogram.BaseEvent) {
    const bookId = String(e.currentTarget.dataset.id);
    if (bookId === this.data.bookId) return;
    const store = readModule('english', ENGLISH_DEFAULTS);
    writeModule('english', { ...store, book: bookId });
    this.setData({ bookId });
    void this.loadBook();
  },

  onPickMode(e: WechatMiniprogram.BaseEvent) {
    const mode = String(e.currentTarget.dataset.mode) === 'dictation' ? 'dictation' : 'spell';
    const store = readModule('english', ENGLISH_DEFAULTS);
    writeModule('english', { ...store, mode });
    this.setData({ mode });
  },

  onOpenLevel(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pkg-english/practice/practice?book=${encodeURIComponent(this.data.bookId)}&level=${Number(e.currentTarget.dataset.index)}` });
  },

  onReview() {
    if (!this.data.due) {
      wx.showToast({ title: '今天没有要复习的词', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pkg-english/practice/practice?review=1' });
  },

  onOpenWords() {
    wx.navigateTo({ url: '/pkg-english/words/words' });
  },

  onRetry() {
    void this.loadBook();
  },
});
