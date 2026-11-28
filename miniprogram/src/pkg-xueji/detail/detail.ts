/**
 * 错题详情（原生）：题目、配图、当时写的、复习计划、做题记录、笔记。不展示答案、讲解、错因。
 * 数据来自 GET /api/error-items/:id（含 learning）与 /practice-records；笔记用 POST /notes 保存。
 */
import { loadContext } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { formatDate, MASTERY_ICON, MASTERY_LABEL, parseKnowledgePoints, toPlainText } from '../../utils/text';
import type { ErrorItemDetail } from '../../utils/types';
import { PAGES } from '../../utils/nav';
import { requireLogin } from '../../utils/auth';
import { isSampleId, sampleDetail, sampleRecords } from '../../utils/sample';
import {
  figureDataUrl,
  type HistoryRow,
  type LearningContext,
  metaLine,
  percent,
  type PlanView,
  type PracticeRecordsResponse,
  previewImage,
  safeImage,
  stars,
  toHistory,
  toPlan,
} from '../../utils/detail';

const NOTES_MAX = 2000;

interface DetailView {
  id: string;
  question: string;
  wrongAnswer: string;
  image: string;
  figure: string;
  kps: string[];
  subjectName: string;
  date: string;
  meta: string;
  stars: number[];
  masteryStatus: string;
  statusLabel: string;
  statusIcon: string;
  notes: string;
}

type DetailItem = ErrorItemDetail & {
  gradeSemester?: string | null;
  source?: string | null;
  paperLevel?: string | null;
  difficultyStars?: number | null;
  figureSvg?: string | null;
  learning?: LearningContext | null;
};

function toView(item: DetailItem): DetailView {
  const status = item.masteryStatus || 'new';
  return {
    id: item.id,
    question: toPlainText(item.questionText) || '（题目见下方图片）',
    wrongAnswer: toPlainText(item.wrongAnswerText),
    image: safeImage(item.originalImageUrl),
    figure: figureDataUrl(item.figureSvg),
    kps: parseKnowledgePoints(item.knowledgePoints),
    subjectName: item.subject ? item.subject.name : '未分类',
    date: formatDate(item.createdAt),
    meta: metaLine(item),
    stars: stars(item.difficultyStars),
    masteryStatus: status,
    statusLabel: MASTERY_LABEL[status] || '',
    statusIcon: MASTERY_ICON[status] || MASTERY_ICON.new,
    notes: (item.userNotes || '').trim(),
  };
}

Page({
  data: {
    id: '',
    item: null as DetailView | null,
    plan: null as PlanView | null,
    historyRows: [] as HistoryRow[],
    historyLoaded: false,
    mastery: -1,
    kidMode: false,
    savingNotes: false,
    error: '',
  },

  async onLoad(query: Record<string, string | undefined>) {
    const id = query.id ? decodeURIComponent(query.id) : '';
    this.setData({ id });
    try {
      if (isSampleId(id)) {
        // 示例题（游客浏览用）：本地数据，不发请求
        const item = sampleDetail();
        const records = sampleRecords();
        this.setData({
          item: toView(item),
          plan: toPlan(item.learning),
          historyRows: toHistory(records.records),
          historyLoaded: true,
          mastery: percent(records.masteryProbability),
        });
        return;
      }
      const ctx = await loadContext();
      this.setData({ kidMode: ctx.kidMode });
      const path = `/api/error-items/${encodeURIComponent(id)}`;
      const [item, records] = await Promise.all([
        request<DetailItem>(path),
        request<PracticeRecordsResponse>(`${path}/practice-records`).catch(() => null),
      ]);
      this.setData({
        item: toView(item),
        plan: toPlan(item.learning),
        historyRows: records ? toHistory(records.records) : [],
        historyLoaded: Boolean(records),
        mastery: records && typeof records.masteryProbability === 'number' ? percent(records.masteryProbability) : -1,
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  onPreviewImage() {
    if (this.data.item) previewImage(this.data.item.image);
  },


  async onEditNotes() {
    const item = this.data.item;
    if (!item || this.data.kidMode || this.data.savingNotes) return;
    // 写笔记会写入数据：游客在这里才登录，登录后继续
    if (!(await requireLogin('登录后才能写笔记'))) return;
    if (isSampleId(this.data.id)) {
      wx.showToast({ title: '示例题不能写笔记', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '笔记',
      editable: true,
      placeholderText: '记下这题要注意的地方',
      content: item.notes,
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return;
        const notes = String(res.content || '').trim().slice(0, NOTES_MAX);
        if (notes !== item.notes) void this.saveNotes(notes);
      },
    });
  },

  async saveNotes(notes: string) {
    this.setData({ savingNotes: true });
    try {
      // wx.request 不支持 PATCH：服务端为同一接口提供了 POST 别名
      await request(`/api/error-items/${encodeURIComponent(this.data.id)}/notes`, { method: 'POST', data: { userNotes: notes || null } });
      this.setData({ 'item.notes': notes });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: toChineseMessage(error), icon: 'none' });
    } finally {
      this.setData({ savingNotes: false });
    }
  },

  /** 再做一遍：从这道题的做题页进来就返回，否则打开做题页 */
  onPractice() {
    if (!this.data.id) return;
    const pages = getCurrentPages();
    const prev = pages.length > 1 ? pages[pages.length - 2] : null;
    if (prev && `/${prev.route}` === PAGES.xjItem && decodeURIComponent(String((prev.options as Record<string, string>).id || '')) === this.data.id) {
      wx.navigateBack();
      return;
    }
    wx.navigateTo({ url: `${PAGES.xjItem}?id=${encodeURIComponent(this.data.id)}` });
  },
});
