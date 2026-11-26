/**
 * 闯关：每课最多 8 题（填数、选择、简答），答完给分，≥80 分点亮这一课。
 * 做错的题可一键收进学迹错题本（数学）。
 */
import { MATH_DEFAULTS, MATH_PASS, readModule, writeModule } from '../../utils/module-store';
import { toChineseMessage } from '../../utils/request';
import { addToNotebook, isKidMode } from '../../utils/to-notebook';
import { checkAnswer, lessonMap, nodeMap, pickQuestions, questionToNotebook, scorePercent } from '../lib/course';
import type { Question } from '../lib/course';
import { loadCourse, loadQuestions } from '../lib/data';

interface Answered { q: Question; given: string; ok: boolean }

Page({
  data: {
    loading: true,
    error: '',
    id: '',
    title: '',
    points: [] as string[],
    questions: [] as Question[],
    index: 0,
    q: null as Question | null,
    input: '',
    picked: '',
    checked: false,
    ok: false,
    answered: [] as Answered[],
    done: false,
    score: 0,
    lit: false,
    wrongCount: 0,
    kidMode: false,
    saving: false,
    saved: false,
  },

  async onLoad(query: Record<string, string | undefined>) {
    const id = decodeURIComponent(query.id || '');
    this.setData({ id, kidMode: isKidMode() });
    try {
      const [course, { kpQuiz, bank }] = await Promise.all([loadCourse(), loadQuestions()]);
      const lesson = lessonMap(course).get(id);
      if (!lesson) throw new Error('找不到这一课');
      const nodes = nodeMap(course);
      const questions = pickQuestions(lesson, kpQuiz, bank);
      if (questions.length === 0) throw new Error('这一课还没有题');
      wx.setNavigationBarTitle({ title: lesson.title });
      this.setData({
        loading: false, title: lesson.title, questions,
        points: lesson.nodes.map((nid) => (nodes.get(nid) || { name: '' }).name).filter(Boolean),
      });
      this.show(0);
    } catch (error) {
      this.setData({ loading: false, error: toChineseMessage(error) });
    }
  },

  show(index: number) {
    this.setData({ index, q: this.data.questions[index], input: '', picked: '', checked: false, ok: false });
  },

  onInput(e: WechatMiniprogram.Input) {
    this.setData({ input: e.detail.value });
  },

  onPick(e: WechatMiniprogram.BaseEvent) {
    if (this.data.checked) return;
    this.setData({ picked: String(e.currentTarget.dataset.key) });
  },

  onCheck() {
    const q = this.data.q;
    if (!q || this.data.checked) return;
    const given = q.type === 'choice' ? this.data.picked : this.data.input;
    if (!given.trim()) {
      wx.showToast({ title: q.type === 'choice' ? '先选一个' : '先写答案', icon: 'none' });
      return;
    }
    const ok = checkAnswer(q, given);
    this.setData({ checked: true, ok, answered: this.data.answered.concat({ q, given, ok }) });
  },

  onNext() {
    const index = this.data.index + 1;
    if (index < this.data.questions.length) {
      this.show(index);
      return;
    }
    this.finish();
  },

  finish() {
    const correct = this.data.answered.filter((a) => a.ok).length;
    const score = scorePercent(correct, this.data.answered.length);
    const store = readModule('math', MATH_DEFAULTS);
    store.best = { ...store.best, [this.data.id]: Math.max(store.best[this.data.id] || 0, score) };
    if (score === 100) store.perfect = (store.perfect || 0) + 1;
    writeModule('math', store);
    this.setData({ done: true, score, lit: score >= MATH_PASS, wrongCount: this.data.answered.length - correct });
  },

  async onSaveWrong() {
    const drafts = this.data.answered.filter((a) => !a.ok).map((a) => {
      const chosen = (a.q.choices || []).find((c) => c.key === a.given);
      return {
        subjectName: '数学' as const,
        ...questionToNotebook(a.q),
        analysis: a.q.explanation || '',
        wrongAnswerText: chosen ? `${a.given}. ${chosen.text}` : a.given,
        knowledgePoints: this.data.points,
      };
    });
    if (drafts.length === 0) return;
    this.setData({ saving: true });
    try {
      const res = await addToNotebook(drafts);
      this.setData({ saved: true });
      wx.showToast({ title: res.duplicated ? `已收 ${res.added} 道，${res.duplicated} 道之前收过` : `已收进错题本 ${res.added} 道`, icon: 'none' });
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onAgain() {
    wx.redirectTo({ url: `/pkg-math/quiz/quiz?id=${encodeURIComponent(this.data.id)}` });
  },

  onBack() {
    wx.navigateBack();
  },
});
