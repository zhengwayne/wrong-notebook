import { loadContext, takeNextReview } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { formatDate, MASTERY_LABEL, parseKnowledgePoints, toPlainText } from '../../utils/text';
import type { ErrorItemDetail, PracticeQuestion } from '../../utils/types';

interface ItemView {
  id: string;
  question: string;
  answer: string;
  analysis: string;
  wrongAnswer: string;
  mistake: string;
  image: string;
  kps: string[];
  subjectName: string;
  date: string;
  masteryStatus: string;
  statusLabel: string;
}

interface PracticeView {
  question: string;
  answer: string;
  analysis: string;
  raw: PracticeQuestion;
  revealed: boolean;
  saved: boolean;
}

function toView(item: ErrorItemDetail): ItemView {
  const status = item.masteryStatus || 'new';
  const image = item.originalImageUrl && /^(data:image\/|https:\/\/)/.test(item.originalImageUrl) ? item.originalImageUrl : '';
  return {
    id: item.id,
    question: toPlainText(item.questionText) || '（无题目文字，见下方原图）',
    answer: toPlainText(item.answerText),
    analysis: toPlainText(item.analysis),
    wrongAnswer: toPlainText(item.wrongAnswerText),
    mistake: toPlainText(item.mistakeAnalysis),
    image,
    kps: parseKnowledgePoints(item.knowledgePoints),
    subjectName: item.subject ? item.subject.name : '未分类',
    date: formatDate(item.createdAt),
    masteryStatus: status,
    statusLabel: MASTERY_LABEL[status] || '',
  };
}

Page({
  data: {
    id: '',
    item: null as ItemView | null,
    reviewMode: false,
    kidMode: false,
    showAnswer: false,
    saving: false,
    recorded: false,
    generating: false,
    practice: null as PracticeView | null,
    nextId: '',
    error: '',
  },

  async onLoad(query: Record<string, string | undefined>) {
    const id = query.id ? decodeURIComponent(query.id) : '';
    this.setData({ id, reviewMode: query.mode === 'review' });
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      this.setData({ kidMode: ctx.kidMode });
      const item = await request<ErrorItemDetail>(`/api/error-items/${encodeURIComponent(id)}`);
      this.setData({ item: toView(item) });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  onReveal() {
    this.setData({ showAnswer: true });
  },

  onPreviewImage() {
    const image = this.data.item?.image;
    if (image && image.startsWith('https://')) wx.previewImage({ urls: [image] });
  },

  async onRecord(e: WechatMiniprogram.BaseEvent) {
    const result = String(e.currentTarget.dataset.result);
    this.setData({ saving: true, error: '' });
    try {
      // 与网页端错题详情「录入结果」一致：source=manual
      await request('/api/practice/record', {
        method: 'POST',
        data: { errorItemId: this.data.id, result, source: 'manual', takenAt: new Date().toISOString() },
      });
      this.setData({ recorded: true });
      this.prepareNext();
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ saving: false });
    }
  },

  async onGenerate() {
    this.setData({ generating: true, error: '' });
    try {
      const res = await request<PracticeQuestion>('/api/practice/generate', {
        method: 'POST',
        data: { errorItemId: this.data.id, language: 'zh' },
        timeout: 120000,
      });
      if (res.pipeline) {
        this.setData({ error: '已在后台出题（多步审核模式），请稍后在网页端「举一反三」查看。' });
        return;
      }
      this.setData({
        practice: {
          question: toPlainText(res.questionText),
          answer: toPlainText(res.answerText),
          analysis: toPlainText(res.analysis),
          raw: res,
          revealed: false,
          saved: false,
        },
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ generating: false });
    }
  },

  onRevealPractice() {
    this.setData({ 'practice.revealed': true });
  },

  async onRecordPractice(e: WechatMiniprogram.BaseEvent) {
    const practice = this.data.practice;
    if (!practice) return;
    const result = String(e.currentTarget.dataset.result);
    this.setData({ saving: true, error: '' });
    try {
      // 与网页端举一反三结果卡一致：附带新题内容，source 默认 practice（专注模式允许）
      await request('/api/practice/record', {
        method: 'POST',
        data: {
          errorItemId: this.data.id,
          result,
          subject: practice.raw.subject || null,
          questionText: practice.raw.questionText,
          answerText: practice.raw.answerText,
          analysis: practice.raw.analysis,
        },
      });
      this.setData({ 'practice.saved': true });
      this.prepareNext();
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ saving: false });
    }
  },

  prepareNext() {
    if (!this.data.reviewMode) return;
    this.setData({ nextId: takeNextReview(this.data.id) || '' });
  },

  onNext() {
    if (!this.data.nextId) return;
    wx.redirectTo({ url: `/pages/item/item?id=${encodeURIComponent(this.data.nextId)}&mode=review` });
  },

  onFinish() {
    wx.switchTab({ url: '/pages/review/review' });
  },
});
