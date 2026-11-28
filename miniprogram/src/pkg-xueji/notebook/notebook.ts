import { loadContext } from '../../utils/context';
import { ApiError, hasKidLockCookie, request, toChineseMessage } from '../../utils/request';
import { formatDate, MASTERY_ICON, MASTERY_LABEL, parseKnowledgePoints, toPlainText } from '../../utils/text';
import {
  DEFAULT_NOTEBOOK_STAGE,
  defaultNotebookName,
  NOTEBOOK_STAGES,
  type NotebookStage,
  type NotebookSubject,
  STAGE_LABELS,
  STAGE_SUBJECTS,
  SUBJECT_LABELS,
  subjectForStage,
} from '../../utils/subjects';
import type { ErrorItemSummary, Notebook, PageResult } from '../../utils/types';
import { requireLogin } from '../../utils/auth';
import { PAGES, switchTo, goHub } from '../../utils/nav';
import { sampleSummary } from '../../utils/sample';

const STAGE_OPTIONS = NOTEBOOK_STAGES.map((value) => ({ value, label: STAGE_LABELS[value] }));

function subjectOptions(stage: NotebookStage) {
  return STAGE_SUBJECTS[stage].map((value) => ({ value, label: SUBJECT_LABELS[value] }));
}

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
    guest: false,
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
    // 新建错题本（学段、学科与网页端相同，只在新建时选择）
    creating: false,
    createBusy: false,
    stageOptions: STAGE_OPTIONS,
    subjectOptions: subjectOptions(DEFAULT_NOTEBOOK_STAGE),
    newStage: DEFAULT_NOTEBOOK_STAGE as NotebookStage,
    newSubject: STAGE_SUBJECTS[DEFAULT_NOTEBOOK_STAGE][0] as NotebookSubject,
    newName: '',
    /** 名称是自动填的（换学科时跟着变）；用户改过就不再自动改 */
    nameAuto: true,
  },

  onShow() {
    void this.init();
  },

  async init() {
    try {
      const ctx = await loadContext();
      if (ctx.guest) {
        // 游客：显示一道示例题；登录后显示自己的错题
        this.setData({
          guest: true, learnerId: null, learnerName: '', kidMode: false, notebooks: [], error: '',
          items: [toRow(sampleSummary())], page: 1, totalPages: 1, total: 1,
        });
        return;
      }
      const changed = ctx.learnerId !== this.data.learnerId || this.data.page === 0 || this.data.guest;
      this.setData({ guest: false, learnerId: ctx.learnerId, learnerName: ctx.learnerName, kidMode: ctx.kidMode });
      // 专注模式下错题列表 / 错题本接口都被专注锁网关拒绝（与网页端一致），只显示锁条和去复习入口
      if (ctx.kidMode) {
        this.setData({ items: [], notebooks: [], page: 0, error: '' });
        return;
      }
      const notebooks = await request<Notebook[]>('/api/notebooks', { query: { learnerId: ctx.learnerId } });
      this.setData({ notebooks });
      if (changed) await this.reload();
    } catch (error) {
      this.setData({ error: toChineseMessage(error), kidMode: this.data.kidMode || hasKidLockCookie() });
    }
  },

  /** 家长在锁条里输对 PIN：回到首页按普通模式重新加载 */
  onKidUnlocked() {
    goHub();
  },

  onGoReview() {
    switchTo(PAGES.xjReview);
  },

  async onPullDownRefresh() {
    if (this.data.kidMode || this.data.guest) {
      wx.stopPullDownRefresh();
      return;
    }
    await this.reload();
    wx.stopPullDownRefresh();
  },

  onReachBottom() {
    if (this.data.kidMode || this.data.guest) return;
    if (this.data.page < this.data.totalPages) void this.loadPage(this.data.page + 1);
  },

  async reload() {
    if (this.data.guest) return;
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

  // ---------- 新建错题本 ----------

  onCreateOpen() {
    if (this.data.kidMode) return;
    const stage = this.data.newStage;
    const subject = subjectForStage(stage, this.data.newSubject);
    this.setData({ creating: true, newSubject: subject, nameAuto: true, newName: this.autoName(stage, subject) });
  },

  onCreateCancel() {
    this.setData({ creating: false });
  },

  autoName(stage: NotebookStage, subject: NotebookSubject): string {
    return defaultNotebookName(stage, subject, this.data.notebooks.map((notebook) => notebook.name));
  },

  onNewStage(e: WechatMiniprogram.BaseEvent) {
    const stage = e.currentTarget.dataset.value as NotebookStage;
    const subject = subjectForStage(stage, this.data.newSubject);
    this.setData({
      newStage: stage,
      newSubject: subject,
      subjectOptions: subjectOptions(stage),
      ...(this.data.nameAuto ? { newName: this.autoName(stage, subject) } : {}),
    });
  },

  onNewSubject(e: WechatMiniprogram.BaseEvent) {
    const subject = e.currentTarget.dataset.value as NotebookSubject;
    this.setData({ newSubject: subject, ...(this.data.nameAuto ? { newName: this.autoName(this.data.newStage, subject) } : {}) });
  },

  onNewName(e: WechatMiniprogram.Input) {
    this.setData({ newName: e.detail.value, nameAuto: false });
  },

  async onCreateSubmit() {
    if (this.data.createBusy) return;
    const name = this.data.newName.trim();
    if (!name) {
      wx.showToast({ title: '起个名字', icon: 'none' });
      return;
    }
    // 新建会写入数据：游客在这里才登录，登录后继续
    if (!(await requireLogin('登录后才能新建错题本'))) return;
    this.setData({ createBusy: true });
    try {
      const created = await request<Notebook>('/api/notebooks', {
        method: 'POST',
        data: { name, stage: this.data.newStage, subjectKey: this.data.newSubject },
      });
      const notebooks = await request<Notebook[]>('/api/notebooks', { query: { learnerId: this.data.learnerId } });
      this.setData({ notebooks, creating: false, subjectId: created.id });
      wx.showToast({ title: '建好了', icon: 'success' });
      await this.reload();
    } catch (error) {
      const message = error instanceof ApiError && error.status === 409 ? '已经有同名的错题本' : toChineseMessage(error);
      wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.setData({ createBusy: false });
    }
  },

  onLogin() {
    void requireLogin();
  },

  /** 登录成功后换成自己的错题 */
  async onLoggedIn() {
    await this.init();
  },

  onCapture() {
    wx.navigateTo({ url: PAGES.xjCapture });
  },

  onOpen(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `${PAGES.xjItem}?id=${encodeURIComponent(String(e.currentTarget.dataset.id))}` });
  },
});
