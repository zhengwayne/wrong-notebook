import type { MpSessionResponse } from './utils/types';

export interface XuejiGlobalData {
  session: MpSessionResponse | null;
  learnerId: string | null;
  /** 复习队列：复习页开始后按顺序逐题打开详情 */
  reviewQueue: string[];
}

App<{ globalData: XuejiGlobalData }>({
  globalData: {
    session: null,
    learnerId: null,
    reviewQueue: [],
  },
});
