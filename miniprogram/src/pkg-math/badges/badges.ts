/** 徽章墙：按本机点亮记录计算，图片来自 math.jjool.com */
import { MATH_DEFAULTS, MATH_PASS, readModule } from '../../utils/module-store';
import { toChineseMessage } from '../../utils/request';
import { SHOW_SYNTH_MEDIA } from '../../config';
import { ATTRIBUTION, computeBadges } from '../lib/course';
import type { Badge } from '../lib/course';
import { loadCourse } from '../lib/data';

Page({
  data: { loading: true, error: '', badges: [] as Badge[], got: 0, attribution: ATTRIBUTION, showImages: SHOW_SYNTH_MEDIA },

  async onShow() {
    try {
      const course = await loadCourse();
      const store = readModule('math', MATH_DEFAULTS);
      const badges = computeBadges(course, store.best, store.perfect, MATH_PASS);
      this.setData({ loading: false, badges, got: badges.filter((b) => b.got).length });
    } catch (error) {
      this.setData({ loading: false, error: toChineseMessage(error) });
    }
  },
});
