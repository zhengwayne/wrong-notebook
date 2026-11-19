import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importQuestionImage, saveParsedQuestion } from '@/lib/question-import';
import { apiClient } from '@/lib/api-client';
import type { ParsedQuestion } from '@/lib/ai';

vi.mock('@/lib/api-client', () => ({ apiClient: { post: vi.fn() } }));
vi.mock('@/lib/image-utils', () => ({ processImageFile: vi.fn(async () => 'data:image/png;base64,dGVzdA==') }));

const parsed: ParsedQuestion = { questionText: '题目', answerText: '答案', analysis: '解析', knowledgePoints: [], subject: '数学', requiresImage: false, wrongAnswerText: '', mistakeAnalysis: '', mistakeStatus: 'unknown', gradeSemester: '四年级下' };
beforeEach(() => vi.mocked(apiClient.post).mockReset());

describe('免确认与批量录入传递识别年级', () => {
    it.each(['四年级下', null])('直接保存保留识别结果 %s，区分人工年级', async (gradeSemester) => {
        vi.mocked(apiClient.post).mockResolvedValue({ id: 'e1' });
        await saveParsedQuestion({ ...parsed, gradeSemester }, {});
        const payload = vi.mocked(apiClient.post).mock.calls[0][1];
        expect(payload).toMatchObject({ recognizedGradeSemester: gradeSemester });
        expect(payload).not.toHaveProperty('gradeSemester');
    });

    it('框选批量流程不会在识别到保存之间丢弃年级', async () => {
        vi.mocked(apiClient.post).mockResolvedValueOnce(parsed).mockResolvedValueOnce({ id: 'e1' });
        await importQuestionImage(new Blob(['test'], { type: 'image/png' }), { language: 'en' });
        expect(vi.mocked(apiClient.post).mock.calls[1][1]).toMatchObject({ recognizedGradeSemester: '四年级下' });
    });

    it('单张图片识别出多道题时全部保存并透传 learnerId', async () => {
        const q2: ParsedQuestion = { ...parsed, questionText: '第二题' };
        vi.mocked(apiClient.post)
            .mockResolvedValueOnce({ ...parsed, items: [parsed, q2] })
            .mockResolvedValueOnce({ id: 'e1', shortId: 'E01' })
            .mockResolvedValueOnce({ id: 'e2', shortId: 'E02' });

        const result = await importQuestionImage(new Blob(['test'], { type: 'image/png' }), {
            language: 'zh',
            subjectId: 'nb-1',
            learnerId: 'child-1',
        });

        expect(vi.mocked(apiClient.post)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(apiClient.post).mock.calls[1][1]).toMatchObject({ questionText: '题目', learnerId: 'child-1', subjectId: 'nb-1' });
        expect(vi.mocked(apiClient.post).mock.calls[2][1]).toMatchObject({ questionText: '第二题', learnerId: 'child-1', subjectId: 'nb-1' });
        expect(result.id).toBe('e1');
        expect(result.savedItems?.map((item) => item.id)).toEqual(['e1', 'e2']);
    });
});
