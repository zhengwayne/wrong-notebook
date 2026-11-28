/**
 * 跨页题分组：相邻照片用「连起来」合成一组，一组作为一道题的几页一起识别。
 * 纯函数，不依赖 wx，便于测试。
 */

/** 一道题最多跨几张照片（与服务端上限一致） */
export const MAX_GROUP_SIZE = 3;

export interface Linkable {
  key: string;
  /** 和前一张连成同一道题 */
  linkPrev: boolean;
}

export interface PageContinuity {
  startsMidQuestion: boolean;
  endsIncomplete: boolean;
}

/** 按连接关系把照片分成若干组（每组是连续的几张），第一张的 linkPrev 不算 */
export function groupKeys(photos: Linkable[]): string[][] {
  const groups: string[][] = [];
  photos.forEach((photo, index) => {
    if (index > 0 && photo.linkPrev) groups[groups.length - 1].push(photo.key);
    else groups.push([photo.key]);
  });
  return groups;
}

/** 一组的标识：组里照片 key 按顺序相连；同样几张照片的结果可以复用 */
export function groupId(keys: string[]): string {
  return keys.join('+');
}

/** 第 index 张与前一张连起来后，合成的组有几张 */
export function mergedSize(photos: Linkable[], index: number): number {
  if (index <= 0 || index >= photos.length) return 0;
  let start = index - 1;
  while (start > 0 && photos[start].linkPrev) start -= 1;
  let end = index;
  while (end + 1 < photos.length && photos[end + 1].linkPrev) end += 1;
  return end - start + 1;
}

/** 调整顺序后，前一张变了的照片断开连接（不会把不相干的两页连在一起） */
export function relinkAfterReorder<T extends Linkable>(before: T[], after: T[]): T[] {
  const prevBefore = new Map(before.map((photo, index) => [photo.key, index > 0 ? before[index - 1].key : '']));
  return after.map((photo, index) => {
    const prev = index > 0 ? after[index - 1].key : '';
    return photo.linkPrev && prevBefore.get(photo.key) !== prev ? { ...photo, linkPrev: false } : photo;
  });
}

/** 删掉一张后，它后面那张不再和前面连（避免把隔开的两页连起来） */
export function removePhotoAt<T extends Linkable>(photos: T[], index: number): T[] {
  return photos
    .filter((_, i) => i !== index)
    .map((photo, i) => (i === index && photo.linkPrev ? { ...photo, linkPrev: false } : photo));
}

/** AI 判断前一组结尾没写完，或后一组开头接着上一页，就建议把两组合成一题 */
export function suggestMerge(prev?: PageContinuity, next?: PageContinuity): boolean {
  return Boolean((prev && prev.endsIncomplete) || (next && next.startsMidQuestion));
}

/** 组里照片的编号：单张「3」，跨页「3-4」 */
export function groupLabel(indexes: number[]): string {
  if (indexes.length === 0) return '';
  const first = indexes[0] + 1;
  const last = indexes[indexes.length - 1] + 1;
  return first === last ? String(first) : `${first}-${last}`;
}
