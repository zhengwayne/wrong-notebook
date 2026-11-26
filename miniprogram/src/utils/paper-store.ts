/** 整页批改的本地状态：没确认的试卷（下次打开录题页可继续）、批改完回录题页时清空照片 */
const PENDING_KEY = 'xueji.mp.pendingPaper';

export interface PendingPaper {
  id: string;
  learnerId: string;
}

export function savePendingPaper(paper: PendingPaper): void {
  wx.setStorageSync(PENDING_KEY, paper);
}

export function readPendingPaper(learnerId: string | null): PendingPaper | null {
  const value = wx.getStorageSync(PENDING_KEY) as PendingPaper | '';
  if (!value || typeof value !== 'object' || !value.id) return null;
  return value.learnerId === learnerId ? value : null;
}

export function clearPendingPaper(): void {
  wx.removeStorageSync(PENDING_KEY);
}

let finished = false;

export function markGradeFinished(): void {
  finished = true;
}

export function takeGradeFinished(): boolean {
  const value = finished;
  finished = false;
  return value;
}
