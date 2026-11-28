/**
 * 小程序跨页题分组（src/utils/photo-groups.ts）：连起来的相邻照片成一组，调整顺序、删除时不误连，AI 跨页判断给出合并建议。
 */
import { describe, expect, it } from 'vitest';
import {
    groupId, groupKeys, groupLabel, MAX_GROUP_SIZE, mergedSize, relinkAfterReorder, removePhotoAt, suggestMerge,
} from '../src/utils/photo-groups';

const photos = (links: boolean[]) => links.map((linkPrev, index) => ({ key: `p${index + 1}`, linkPrev }));

describe('跨页分组', () => {
    it('按连接关系分组，第一张的连接无效', () => {
        expect(groupKeys(photos([true, true, false, false, true]))).toEqual([['p1', 'p2'], ['p3'], ['p4', 'p5']]);
        expect(groupId(['p1', 'p2'])).toBe('p1+p2');
        expect(groupLabel([2])).toBe('3');
        expect(groupLabel([2, 3])).toBe('3-4');
    });

    it('连起来后的组大小，用于限制每组最多 3 张', () => {
        expect(MAX_GROUP_SIZE).toBe(3);
        const list = photos([false, true, false, false, true]);
        expect(mergedSize(list, 2)).toBe(3); // [p1 p2] + [p3]
        expect(mergedSize(list, 3)).toBe(3); // [p3] + [p4 p5]
        expect(mergedSize(photos([false, true, false, true]), 2)).toBe(4);
        expect(mergedSize(list, 0)).toBe(0);
    });

    it('调整顺序后前一张变了的断开，没变的保持', () => {
        const before = photos([false, true, false, true]);
        const after = [before[0], before[1], before[3], before[2]];
        expect(relinkAfterReorder(before, after).map((p) => p.linkPrev)).toEqual([false, true, false, false]);
    });

    it('删掉组中间一张，后面那张不会连到前面去', () => {
        const result = removePhotoAt(photos([false, true, true]), 1);
        expect(result.map((p) => [p.key, p.linkPrev])).toEqual([['p1', false], ['p3', false]]);
    });

    it('AI 判断前一页没写完或后一页接着前一页时建议合并', () => {
        expect(suggestMerge({ startsMidQuestion: false, endsIncomplete: true }, { startsMidQuestion: false, endsIncomplete: false })).toBe(true);
        expect(suggestMerge(undefined, { startsMidQuestion: true, endsIncomplete: false })).toBe(true);
        expect(suggestMerge({ startsMidQuestion: true, endsIncomplete: false }, { startsMidQuestion: false, endsIncomplete: true })).toBe(false);
        expect(suggestMerge(undefined, undefined)).toBe(false);
    });
});
