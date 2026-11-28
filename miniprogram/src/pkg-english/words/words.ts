/** 生词本：拼错过的词 / 全部学过的词；点一下听发音，拼错过的词可一键收进学迹错题本。 */
import { ENGLISH_DEFAULTS, readModule } from '../../utils/module-store';
import { toChineseMessage } from '../../utils/request';
import { speak } from '../../utils/speech';
import { SHOW_SYNTH_MEDIA } from '../../config';
import { requireLogin } from '../../utils/auth';
import { addToNotebook, isKidMode } from '../../utils/to-notebook';
import { wordToNotebook } from '../lib/words';

interface Row { name: string; trans: string; wrong: number; box: number; due: boolean }

Page({
  data: {
    tab: 'wrong' as 'wrong' | 'all',
    rows: [] as Row[],
    wrongTotal: 0,
    allTotal: 0,
    kidMode: false,
    saving: false,
    speech: SHOW_SYNTH_MEDIA,
  },

  onShow() {
    this.setData({ kidMode: isKidMode() });
    this.refresh();
  },

  refresh() {
    const store = readModule('english', ENGLISH_DEFAULTS);
    const now = Date.now();
    const all: Row[] = Object.entries(store.words)
      .map(([name, s]) => ({ name, trans: s.t, wrong: s.w, box: s.b, due: s.d <= now }))
      .sort((a, b) => b.wrong - a.wrong || a.name.localeCompare(b.name));
    const wrong = all.filter((row) => row.wrong > 0);
    this.setData({ rows: this.data.tab === 'wrong' ? wrong : all, wrongTotal: wrong.length, allTotal: all.length });
  },

  onTab(e: WechatMiniprogram.BaseEvent) {
    this.setData({ tab: String(e.currentTarget.dataset.tab) === 'all' ? 'all' : 'wrong' });
    this.refresh();
  },

  async onSpeak(e: WechatMiniprogram.BaseEvent) {
    if (!SHOW_SYNTH_MEDIA) return;
    const ok = await speak(String(e.currentTarget.dataset.name), 'en');
    if (!ok) wx.showToast({ title: '发音暂时不可用', icon: 'none' });
  },

  async onSaveAll() {
    if (!(await requireLogin('登录后才能收进错题本'))) return;
    const store = readModule('english', ENGLISH_DEFAULTS);
    const drafts = Object.entries(store.words)
      .filter(([, s]) => s.w > 0)
      .slice(0, 30)
      .map(([name, s]) => ({ subjectName: '英语' as const, ...wordToNotebook(name, s), knowledgePoints: ['单词拼写'] }));
    if (drafts.length === 0) return;
    this.setData({ saving: true });
    try {
      const res = await addToNotebook(drafts);
      wx.showToast({ title: `新收 ${res.added} 个${res.duplicated ? `，${res.duplicated} 个已在错题本` : ''}`, icon: 'none' });
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
