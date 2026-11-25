import { loadContext } from '../../utils/context';
import { request, toChineseMessage } from '../../utils/request';
import { formatDate, MASTERY_ICON, MASTERY_LABEL, parseKnowledgePoints, toPlainText } from '../../utils/text';
import type { ErrorItemSummary, Notebook, PageResult } from '../../utils/types';

interface ListRow {
  id: string;
  plain: string;
  kps: string[];
  masteryStatus: string;
  statusLabel: string;
  statusIcon: string;
  date: string;
}

const PAGE_SIZE = 20;

function toRow(item: ErrorItemSummary): ListRow {
  const status = item.masteryStatus || 'new';
  return {
    id: item.id,
    plain: toPlainText(item.questionText) || '（只有图片，点开看）',
    kps: parseKnowledgePoints(item.knowledgePoints).slice(0, 2),
    masteryStatus: status,
    statusLabel: MASTERY_LABEL[status] || '',
    statusIcon: MASTERY_ICON[status] || MASTERY_ICON.new,
    date: formatDate(item.createdAt),
  };
}

Page({
  data: {
    learnerId: null as string | null,
    learnerName: '',
    kidMode: false,
    showFilters: false,
    notebooks: [] as Notebook[],
    subjectId: '',
    mastery: '',
    timeRange: 'all',
    query: '',
    masteryOptions: [
      { value: '', label: '全部', icon: '', iconOn: '' },
      { value: 'new', label: '待复习', icon: '/assets/icons/circle-dot-o.svg', iconOn: '/assets/icons/circle-dot-w.svg' },
      { value: 'reviewing', label: '复习中', icon: '/assets/icons/refresh-cw-p.svg', iconOn: '/assets/icons/refresh-cw-w.svg' },
      { value: 'mastered', label: '已掌握', icon: '/assets/icons/circle-check-s.svg', iconOn: '/assets/icons/circle-check-w.svg' },
    ],
    timeOptions: [
      { value: 'all', label: '不限时间' },
      { value: 'week', label: '近一周' },
      { value: 'month', label: '近一月' },
    ],
    items: [] as ListRow[],
    page: 0,
    totalPages: 1,
    total: 0,
    loading: false,
    error: '',
  },

  onShow() {
    void this.init();
  },

  async init() {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      const changed = ctx.learnerId !== this.data.learnerId || this.data.page === 0;
      this.setData({ learnerId: ctx.learnerId, learnerName: ctx.learnerName, kidMode: ctx.kidMode });
      const notebooks = await request<Notebook[]>('/api/notebooks', { query: { learnerId: ctx.learnerId } });
      this.setData({ notebooks });
      if (changed) await this.reload();
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  async onPullDownRefresh() {
    await this.reload();
    wx.stopPullDownRefresh();
  },

  onReachBottom() {
    if (this.data.page < this.data.totalPages) void this.loadPage(this.data.page + 1);
  },

  async reload() {
    this.setData({ items: [], page: 0, totalPages: 1 });
    await this.loadPage(1);
  },

  async loadPage(page: number) {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    try {
      const res = await request<PageResult<ErrorItemSummary>>('/api/error-items/list', {
        query: {
          page,
          pageSize: PAGE_SIZE,
          learnerId: this.data.learnerId,
          subjectId: this.data.subjectId,
          mastery: this.data.mastery,
          timeRange: this.data.timeRange,
          query: this.data.query,
        },
      });
      const rows = res.items.map(toRow);
      this.setData({
        items: page === 1 ? rows : this.data.items.concat(rows),
        page: res.page,
        totalPages: res.totalPages,
        total: res.total,
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearch(e: WechatMiniprogram.Input) {
    this.setData({ query: e.detail.value.trim() });
    void this.reload();
  },

  onSubject(e: WechatMiniprogram.BaseEvent) {
    this.setData({ subjectId: String(e.currentTarget.dataset.id || '') });
    void this.reload();
  },

  onMastery(e: WechatMiniprogram.BaseEvent) {
    this.setData({ mastery: String(e.currentTarget.dataset.value || '') });
    void this.reload();
  },

  onTimeRange(e: WechatMiniprogram.BaseEvent) {
    this.setData({ timeRange: String(e.currentTarget.dataset.value || 'all') });
    void this.reload();
  },

  onToggleFilters() {
    this.setData({ showFilters: !this.data.showFilters });
  },

  onCapture() {
    wx.navigateTo({ url: '/pages/capture/capture' });
  },

  onOpen(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pages/item/item?id=${encodeURIComponent(String(e.currentTarget.dataset.id))}` });
  },
});
