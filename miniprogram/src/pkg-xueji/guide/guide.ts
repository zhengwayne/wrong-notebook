/** 我的 › 新手引导：重新打开后在这里看步骤；有多个身份时可以切换 */
import { loadContext } from '../../utils/context';
import { toChineseMessage } from '../../utils/request';
import { goHub, PAGES } from '../../utils/nav';
import { guidePersonaFor, isGuidePersona, setGuideVisible, type GuidePersona } from '../../utils/onboarding';

const LABEL: Record<GuidePersona, string> = { teacher: '老师', parent: '家长', self: '学生' };

Page({
  data: {
    persona: '' as GuidePersona | '',
    options: [] as Array<{ value: GuidePersona; label: string }>,
    refresh: 0,
    error: '',
  },

  async onLoad(query: Record<string, string | undefined>) {
    try {
      const ctx = await loadContext();
      if (!ctx) return;
      if (ctx.kidMode) {
        goHub();
        return;
      }
      const { user } = ctx.session;
      const personas = user.personas.filter(isGuidePersona);
      const persona = isGuidePersona(query.persona) ? query.persona : guidePersonaFor(user);
      this.setData({
        persona,
        options: (personas.length ? personas : [persona]).map((value) => ({ value, label: LABEL[value] })),
      });
    } catch (error) {
      this.setData({ error: toChineseMessage(error) });
    }
  },

  onShow() {
    if (this.data.persona) this.setData({ refresh: this.data.refresh + 1 });
  },

  async onSwitch(e: WechatMiniprogram.BaseEvent) {
    const value = String(e.currentTarget.dataset.value);
    if (!isGuidePersona(value) || value === this.data.persona) return;
    try {
      await setGuideVisible(value, true);
    } catch {
      // 打开失败也照样显示步骤
    }
    this.setData({ persona: value, refresh: this.data.refresh + 1 });
  },

  onHelp() {
    wx.navigateTo({ url: PAGES.xjHelp });
  },
});
