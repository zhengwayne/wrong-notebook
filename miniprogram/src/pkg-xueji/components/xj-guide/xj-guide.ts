/**
 * 新手引导卡：步骤按真实进度打勾，当前一步给按钮。老师的步骤在电脑上做：按钮弹出底部面板，复制一次性网页链接。
 * persona：哪个身份；refresh：父页面每次 onShow 加一，卡片随之重新拉进度；always：在引导页里即使收起也显示。
 */
import { PAGES, openMe, switchTo } from '../../../utils/nav';
import { toChineseMessage } from '../../../utils/request';
import {
  buildGuideView, fetchGuide, guideAction, isGuidePersona, ROSTER_EXAMPLE, setGuideVisible,
  type GuideStatus, type GuideView,
} from '../../../utils/onboarding';
import { openWebPage, resolveWebLink } from '../../../utils/web-link';

/** 每个身份最近一次的进度（按钮跳转要用里面的 id） */
const lastStatus: Record<string, GuideStatus> = {};

Component({
  options: { addGlobalClass: true },
  properties: {
    persona: { type: String, value: '' },
    refresh: { type: Number, value: 0 },
    always: { type: Boolean, value: false },
  },
  data: {
    view: null as GuideView | null,
    show: false,
    sheet: false,
    sheetTitle: '',
    sheetDesc: '',
    sheetUrl: '',
    sheetPath: '',
    sheetOneTime: false,
    sheetRoster: false,
    sheetLoading: false,
  },
  observers: {
    'persona, refresh': function () { void (this as unknown as { load: () => Promise<void> }).load(); },
  },
  methods: {
    async load() {
      const persona = this.data.persona;
      if (!isGuidePersona(persona)) return;
      try {
        const status = await fetchGuide(persona);
        lastStatus[persona] = status;
        const show = this.data.always || status.visible;
        this.setData({ view: buildGuideView(status), show });
        this.triggerEvent('loaded', { visible: status.visible, doneCount: status.doneCount, total: status.total, completed: status.completed });
      } catch {
        // 取不到进度就不显示卡片，不影响首页
        this.setData({ show: false });
      }
    },

    async onCollapse() {
      const persona = this.data.persona;
      if (!isGuidePersona(persona)) return;
      try {
        await setGuideVisible(persona, false);
        this.setData({ show: this.data.always });
        wx.showToast({ title: '已收起，可在「我的」里再打开', icon: 'none' });
        this.triggerEvent('collapsed');
      } catch (error) {
        wx.showToast({ title: toChineseMessage(error), icon: 'none' });
      }
    },

    onStep(e: WechatMiniprogram.BaseEvent) {
      const key = String(e.currentTarget.dataset.key || '');
      const status = lastStatus[this.data.persona];
      if (!status || !key) return;
      const action = guideAction(status, key);
      if (action.kind === 'web') {
        void this.openSheet(key, action.path);
        return;
      }
      switch (action.target) {
        case 'me': openMe(); break;
        case 'capture': wx.navigateTo({ url: PAGES.xjCapture }); break;
        case 'grade': wx.navigateTo({ url: `${PAGES.xjGrade}?id=${encodeURIComponent(action.id || '')}` }); break;
        case 'review': switchTo(PAGES.xjReview); break;
        case 'notebook': switchTo(PAGES.xjNotebook); break;
        default: wx.navigateTo({ url: PAGES.xjParent });
      }
    },

    async openSheet(key: string, path: string) {
      const view = this.data.view;
      const step = view ? view.steps.find((s) => s.key === key) : null;
      const where = path === '/teacher' ? '老师首页' : path.endsWith('/papers') ? '答卷复核' : path === '/grading' ? '「收卷 / 改卷」' : '这次改卷';
      this.setData({
        sheet: true,
        sheetLoading: true,
        sheetTitle: step ? `第${step.index}步 · ${step.title}` : view ? view.finish.title : '在电脑上做',
        sheetDesc: `在电脑浏览器打开下面的链接，会自动登录并进入${where}页。`,
        sheetUrl: '',
        sheetRoster: key === 'class',
        sheetPath: path,
      });
      const link = await resolveWebLink(path);
      if (!link) {
        this.setData({ sheet: false, sheetLoading: false });
        wx.showToast({ title: '专注模式下不能打开这个页面', icon: 'none' });
        return;
      }
      this.setData({ sheetUrl: link.url, sheetOneTime: link.oneTime, sheetLoading: false });
    },

    onCloseSheet() { this.setData({ sheet: false }); },

    /** 先在手机上看一眼：小程序里打开同一页（会重新申请一次性链接） */
    onOpenHere() {
      const path = this.data.sheetPath;
      this.setData({ sheet: false });
      if (path) openWebPage(path);
    },
    noop() { /* 阻止点面板时关闭 */ },

    onCopyLink() {
      const url = this.data.sheetUrl;
      if (!url) return;
      wx.setClipboardData({
        data: url,
        success: () => {
          wx.hideToast();
          wx.showToast({ title: '链接已复制', icon: 'success' });
        },
        fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
      });
    },

    onRoster() {
      wx.showModal({
        title: '名册格式',
        content: '第一行是表头，之后每行一个学生：\n班级  学号  姓名\n七年级1班  01  张三\n可以从 Excel 直接复制粘贴。',
        confirmText: '复制示例',
        cancelText: '关闭',
        success: (res) => {
          if (res.confirm) wx.setClipboardData({ data: ROSTER_EXAMPLE });
        },
      });
    },
  },
});
