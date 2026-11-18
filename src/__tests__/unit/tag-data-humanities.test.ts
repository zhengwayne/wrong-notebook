import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
    prisma: {
        knowledgeTag: {
            findMany: mocks.findMany,
        },
    },
}));

import {
    CHINESE_CURRICULUM,
    HISTORY_CURRICULUM,
    GEOGRAPHY_CURRICULUM,
    POLITICS_CURRICULUM,
} from '@/lib/tag-data';
import { getScopeTagsFromDB, getTagsFromDB } from '@/lib/ai/tag-service';

describe('语文与史地政课标标签库及静态回退', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('语文覆盖小学一年级至高三全部学段且各年级标签非空', () => {
        for (const grade of ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一上', '高三']) {
            const chapters = CHINESE_CURRICULUM[grade];
            expect(chapters, `语文缺少 ${grade} 节点`).toBeDefined();
            const tags = chapters.flatMap((c) => c.tags);
            expect(tags.length, `语文 ${grade} 标签为空`).toBeGreaterThan(0);
        }
    });

    it('历史、地理、政治初高中各年级均具备非空标准标签', () => {
        for (const [name, curriculum] of [
            ['历史', HISTORY_CURRICULUM],
            ['地理', GEOGRAPHY_CURRICULUM],
            ['政治', POLITICS_CURRICULUM],
        ] as const) {
            const total = Object.values(curriculum).flatMap((chapters) => chapters.flatMap((c) => c.tags));
            expect(total.length, `${name} 总标签数应大于 20`).toBeGreaterThan(20);
        }
    });

    it('存量数据库未同步文科标签或仅含空年级壳时，getScopeTagsFromDB 与 getTagsFromDB 自动回退静态课标且不混入年级名', async () => {
        // 模拟旧数据库仅存在无子节点的空年级顶层壳
        mocks.findMany.mockResolvedValue([
            { id: 'g7', name: '七年级', parentId: null },
            { id: 'g8', name: '八年级', parentId: null },
        ]);

        const primaryChinese = await getScopeTagsFromDB('chinese', 'primary');
        expect(primaryChinese.length).toBeGreaterThan(10);
        expect(primaryChinese).not.toContain('一年级');

        const juniorChinese = await getScopeTagsFromDB('chinese', 'junior_high');
        expect(juniorChinese.length).toBeGreaterThan(10);
        expect(juniorChinese).not.toContain('七年级');

        mocks.findMany.mockResolvedValue([]);
        const allHistory = await getTagsFromDB('history');
        expect(allHistory.length).toBeGreaterThan(20);
    });
});
