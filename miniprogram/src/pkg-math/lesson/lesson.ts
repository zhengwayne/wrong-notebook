/** 一课：插图、要学会的知识点、先修知识，然后开始闯关。 */
import { MATH_DEFAULTS, MATH_PASS, readModule } from '../../utils/module-store';
import { toChineseMessage } from '../../utils/request';
import { SHOW_SYNTH_MEDIA } from '../../config';
import { ATTRIBUTION, heroUrl, lessonMap, nodeMap } from '../lib/course';
import { loadArt, loadCourse } from '../lib/data';

interface PointView { id: string; name: string; description: string; mastery: string[] }
interface PrereqView { name: string; lessonId: string }

Page({
  data: {
    loading: true,
    error: '',
    id: '',
    title: '',
    book: '',
    hero: '',
    points: [] as PointView[],
    prereqs: [] as PrereqView[],
    best: 0,
    lit: false,
    attribution: ATTRIBUTION,
  },

  async onLoad(query: Record<string, string | undefined>) {
    const id = decodeURIComponent(query.id || '');
    this.setData({ id });
    try {
      const [course, art] = await Promise.all([loadCourse(), loadArt()]);
      const lesson = lessonMap(course).get(id);
      if (!lesson) throw new Error('找不到这一课');
      const nodes = nodeMap(course);
      const points = lesson.nodes.map((nid) => nodes.get(nid)).filter((n): n is NonNullable<typeof n> => Boolean(n)).map((n) => ({
        id: n.id, name: n.name, description: n.description || '', mastery: n.mastery || [],
      }));
      const prereqs = (lesson.prereqNodes || []).map((nid) => nodes.get(nid)).filter((n): n is NonNullable<typeof n> => Boolean(n)).map((n) => ({
        name: n.name, lessonId: (n.lessons || []).find((lid) => course.path.includes(lid)) || '',
      }));
      wx.setNavigationBarTitle({ title: lesson.title });
      this.setData({ loading: false, title: lesson.title, book: lesson.book, hero: heroUrl(id, art, SHOW_SYNTH_MEDIA), points, prereqs });
    } catch (error) {
      this.setData({ loading: false, error: toChineseMessage(error) });
    }
  },

  onShow() {
    const best = readModule('math', MATH_DEFAULTS).best[this.data.id] || 0;
    this.setData({ best, lit: best >= MATH_PASS });
  },

  onStart() {
    wx.navigateTo({ url: `/pkg-math/quiz/quiz?id=${encodeURIComponent(this.data.id)}` });
  },

  onOpenPrereq(e: WechatMiniprogram.BaseEvent) {
    const lessonId = String(e.currentTarget.dataset.id || '');
    if (lessonId) wx.navigateTo({ url: `/pkg-math/lesson/lesson?id=${encodeURIComponent(lessonId)}` });
  },
});
