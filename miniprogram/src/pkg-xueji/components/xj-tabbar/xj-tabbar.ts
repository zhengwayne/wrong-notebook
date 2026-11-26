/**
 * 错题本底栏（代替原生 tabBar：三合一后错题本在分包里，原生 tabBar 页面只能放主包）。
 * active：当前页的 key（home / notebook / review）；「我的」在主包，点了打开后返回仍回到这里。
 */
import { openMe, PAGES, switchTo } from '../../../utils/nav';

const TABS = [
  { key: 'home', text: '首页', url: PAGES.xjHome, icon: '/assets/tabbar/home.png', iconOn: '/assets/tabbar/home-active.png' },
  { key: 'notebook', text: '错题本', url: PAGES.xjNotebook, icon: '/assets/tabbar/notebook.png', iconOn: '/assets/tabbar/notebook-active.png' },
  { key: 'review', text: '复习', url: PAGES.xjReview, icon: '/assets/tabbar/review.png', iconOn: '/assets/tabbar/review-active.png' },
  { key: 'me', text: '我的', url: PAGES.me, icon: '/assets/tabbar/me.png', iconOn: '/assets/tabbar/me-active.png' },
];

Component({
  options: { addGlobalClass: true },
  properties: {
    active: { type: String, value: '' },
  },
  data: { tabs: TABS },
  methods: {
    onTap(e: WechatMiniprogram.BaseEvent) {
      const key = String(e.currentTarget.dataset.key);
      if (key === this.data.active) return;
      const tab = TABS.find((item) => item.key === key);
      if (!tab) return;
      if (key === 'me') openMe();
      else switchTo(tab.url);
    },
  },
});
