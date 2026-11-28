/** 学数学首页：按年级分站的课程路线，每课闯关 ≥80 分点亮一颗星。 */
import { loadContext } from '../../utils/context';
import { MATH_DEFAULTS, MATH_PASS, mathStarCount, readModule } from '../../utils/module-store';
import { toChineseMessage } from '../../utils/request';
import { ATTRIBUTION, campChapters, listCamps } from '../lib/course';
import type { Camp, Course } from '../lib/course';
import { loadCourse } from '../lib/data';

const CAMP_KEY = 'xueji.mp.math.camp';

interface StationView { id: string; title: string; no: number; lit: boolean; score: number }
interface GroupView { chapter: string; stations: StationView[] }

let course: Course | null = null;

Page({
  data: {
    loading: true,
    error: '',
    camps: [] as Camp[],
    camp: '',
    groups: [] as GroupView[],
    stars: 0,
    total: 0,
    attribution: ATTRIBUTION,
  },

  async onShow() {
    try {
      await loadContext();
      course = await loadCourse();
      const camps = listCamps(course);
      const saved = String(wx.getStorageSync(CAMP_KEY) || '');
      const camp = camps.some((item) => item.key === saved) ? saved : (camps.find((item) => item.key === '7上') || camps[0]).key;
      this.setData({ camps, camp, total: course.path.length, loading: false, error: '' });
      this.render();
    } catch (error) {
      this.setData({ loading: false, error: toChineseMessage(error) });
    }
  },

  render() {
    if (!course) return;
    const store = readModule('math', MATH_DEFAULTS);
    let no = 0;
    const groups = campChapters(course, this.data.camp).map((group) => ({
      chapter: group.chapter,
      stations: group.stations.map((station) => {
        no += 1;
        const score = store.best[station.id] || 0;
        return { id: station.id, title: station.title, no, lit: score >= MATH_PASS, score };
      }),
    }));
    this.setData({ groups, stars: mathStarCount(store) });
  },

  onPickCamp(e: WechatMiniprogram.BaseEvent) {
    const camp = String(e.currentTarget.dataset.key);
    wx.setStorageSync(CAMP_KEY, camp);
    this.setData({ camp });
    this.render();
  },

  onOpenLesson(e: WechatMiniprogram.BaseEvent) {
    wx.navigateTo({ url: `/pkg-math/lesson/lesson?id=${encodeURIComponent(String(e.currentTarget.dataset.id))}` });
  },

  onOpenBadges() {
    wx.navigateTo({ url: '/pkg-math/badges/badges' });
  },

  onRetry() {
    this.setData({ loading: true, error: '' });
    void this.onShow();
  },
});

