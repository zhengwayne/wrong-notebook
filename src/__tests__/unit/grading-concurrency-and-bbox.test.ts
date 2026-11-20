import { describe, expect, it, vi } from 'vitest';

const cropMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/parent-paper-crop', () => ({
    cropDataUrlRegion: cropMock,
}));

import { parseExamPaperByMode } from '@/lib/ai/exam-paper-read';
import { resolveCroppedGradingItemImage, runBoundedConcurrency } from '@/lib/grading-bbox-and-pool';

describe('Task 2.2: 教师读卷 bbox/置信度解析、有界并发调度与单题裁切', () => {
    it('parseExamPaperByMode 在 student 模式下解析校验归一化 bbox、confidence 与卷面书写外观预警', () => {
        const raw = JSON.stringify({
            studentName: '李明',
            className: '初二3班',
            studentNo: '07',
            paperAppearance: {
                handwritingLevel: 'good',
                neatnessLevel: 'fair',
                attitudeLevel: 'excellent',
                visualAlerts: ['heavy_erasure', 'invalid_alert'],
            },
            questions: [
                {
                    number: '1',
                    answer: 'B',
                    score: null,
                    confidence: 0.96,
                    bbox: { pageIndex: 0, x: 0.1, y: 0.2, width: 0.8, height: 0.15 },
                },
                {
                    number: '2',
                    answer: '解：x=3',
                    score: 8,
                    confidence: 0.72,
                    // pageIndex 超出总页数应被过滤为 null
                    bbox: { pageIndex: 5, x: 0.1, y: 0.5, width: 0.8, height: 0.2 },
                },
            ],
        });

        const parsed = parseExamPaperByMode('student', raw, 2);
        expect(parsed.studentName).toBe('李明');
        expect(parsed.paperAppearance).toEqual({
            handwritingLevel: 'good',
            neatnessLevel: 'fair',
            attitudeLevel: 'excellent',
            visualAlerts: ['heavy_erasure'],
        });
        expect(parsed.questions[0].confidence).toBe(0.96);
        expect(parsed.questions[0].bbox).toEqual({ pageIndex: 0, x: 0.1, y: 0.2, width: 0.8, height: 0.15 });
        expect(parsed.questions[1].bbox).toBeNull();
    });

    it('runBoundedConcurrency 并行处理任务但严格遵守最大并发度上限', async () => {
        let active = 0;
        let maxObserved = 0;
        const visited: number[] = [];

        await runBoundedConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
            active += 1;
            maxObserved = Math.max(maxObserved, active);
            await new Promise((r) => setTimeout(r, 15));
            visited.push(item);
            active -= 1;
        });

        expect(maxObserved).toBeGreaterThan(1);
        expect(maxObserved).toBeLessThanOrEqual(3);
        expect(visited.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('确认入库时按单题 bbox 所在页精准裁切，无有效 bbox 时回退至首页整图', async () => {
        cropMock.mockResolvedValueOnce({ imageUrl: 'data:image/jpeg;base64,CROPPED_P1', cropped: true });
        const pages = ['data:image/jpeg;base64,PAGE0', 'data:image/jpeg;base64,PAGE1'];

        const croppedUrl = await resolveCroppedGradingItemImage(
            pages,
            JSON.stringify({ pageIndex: 1, x: 0.12, y: 0.3, width: 0.76, height: 0.22 }),
        );
        expect(croppedUrl).toBe('data:image/jpeg;base64,CROPPED_P1');
        expect(cropMock).toHaveBeenCalledWith('data:image/jpeg;base64,PAGE1', {
            x: 0.12,
            y: 0.3,
            width: 0.76,
            height: 0.22,
        });

        const fallbackUrl = await resolveCroppedGradingItemImage(pages, null);
        expect(fallbackUrl).toBe('data:image/jpeg;base64,PAGE0');
    });
});
