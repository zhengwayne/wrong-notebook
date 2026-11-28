import { loadContext, takeNextReview } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { formatDate, MASTERY_ICON, MASTERY_LABEL, parseKnowledgePoints, toPlainText } from '../../utils/text';
import type { ErrorItemDetail } from '../../utils/types';
import { PAGES, switchTo } from '../../utils/nav';
import { previewImage } from '../../utils/detail';

interface ItemView {
  id: string;
  question: string;
  wrongAnswer: string;
  image: string;
  kps: string[];
  subjectName: string;
  date: string;
  masteryStatus: string;
  statusLabel: string;
  statusIcon: string;
}

function toView(item: ErrorItemDetail): ItemView {
  const status = item.masteryStatus || 'new';
  const image = item.originalImageUrl && /^(data:image\/|https:\/\/)/.test(item.originalImageUrl) ? item.originalImageUrl : '';
  return {
    id: item.id,
    question: toPlainText(item.questionText) || '（题目见下方图片）',
    wrongAnswer: toPlainText(item.wrongAnswerText),
    image,
    kps: parseKnowledgePoints(item.knowledgePoints),
    subjectName: item.subject ? item.subject.name : '未分类',
    date: formatDate(item.createdAt),
    masteryStatus: status,
    statusLabel: MASTERY_LABEL[status] || '',
    statusIcon: MASTERY_ICON[status] || MASTERY_ICON.new,
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

  /** 查看详情：小程序里的错题详情页（做题记录、复习、笔记） */
  onOpenDetail() {
    if (this.data.id) wx.navigateTo({ url: `${PAGES.xjDetail}?id=${encodeURIComponent(this.data.id)}` });
  },

  onReveal() {
    this.setData({ showAnswer: true });
  },

  onPreviewImage() {
    const image = this.data.item?.image;
    if (image) previewImage(image);
  },

  async onRecord(e: WechatMiniprogram.BaseEvent) {
    if (this.data.saving || this.data.recorded) return;
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

  prepareNext() {
    if (!this.data.reviewMode) return;
    this.setData({ nextId: takeNextReview(this.data.id) || '' });
  },

  onNext() {
    if (!this.data.nextId) return;
    wx.redirectTo({ url: `${PAGES.xjItem}?id=${encodeURIComponent(this.data.nextId)}&mode=review` });
  },

  onFinish() {
    switchTo(PAGES.xjReview);
  },
});
