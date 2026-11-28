// @vitest-environment node
/**
 * 跨页题合并：识别输出里的跨页衔接判断、多页提示规则、保存用的拼图。
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { extractPageContinuity, parseAnalyzeResponse, toAnalyzeImageResult } from '@/lib/ai/parse-analyze';
import { generateAnalyzePrompt, generateMultiPageRules } from '@/lib/ai/prompts';
import { generateAnalyzeRequest } from '@/lib/ai/prompt-requests';
import { normalizeImageBuffer, stitchImages } from '@/lib/server/image-normalize';

const ITEM = '<question_text>已知</question_text><answer_text>1</answer_text><analysis>解</analysis>';

describe('跨页衔接判断', () => {
    it('解析 page_continuity 并且不影响按题拆分', () => {
        const text = `<item>${ITEM}</item><item>${ITEM.replace('已知', '第二题')}</item>\n<page_continuity><starts_mid_question>true</starts_mid_question><ends_incomplete>false</ends_incomplete></page_continuity>`;
        const parsed = parseAnalyzeResponse(text);
        expect(parsed.items).toHaveLength(2);
        expect(parsed.items[1].questionText).toContain('第二题');
        expect(parsed.continuity).toEqual({ startsMidQuestion: true, endsIncomplete: false });
        expect(toAnalyzeImageResult(parsed.items, 0, 'p1', parsed.continuity).continuity).toEqual(parsed.continuity);
    });

    it('单题旧格式也能解析，缺失或无法判断时为 false', () => {
        const parsed = parseAnalyzeResponse(`${ITEM}<page_continuity><ends_incomplete> TRUE </ends_incomplete></page_continuity>`);
        expect(parsed.items[0].analysis).toBe('解');
        expect(parsed.continuity).toEqual({ startsMidQuestion: false, endsIncomplete: true });
        expect(parseAnalyzeResponse(ITEM).continuity).toBeUndefined();
        expect(toAnalyzeImageResult(parseAnalyzeResponse(ITEM).items)).not.toHaveProperty('continuity');
    });

    it('输出被截断时去掉未闭合的块', () => {
        const { continuity, rest } = extractPageContinuity(`${ITEM}<page_continuity><starts_mid_question>true</starts_mid_question>`);
        expect(continuity).toEqual({ startsMidQuestion: true, endsIncomplete: false });
        expect(rest).toBe(ITEM);
    });
});

describe('多页提示规则', () => {
    it('只有 2~3 张时追加多页规则，跨页判断规则始终在输出协议里', () => {
        expect(generateMultiPageRules(undefined)).toBe('');
        expect(generateMultiPageRules(1)).toBe('');
        expect(generateMultiPageRules(2)).toContain('共 2 张图片');
        expect(generateMultiPageRules(9)).toContain('共 3 张图片');
        const single = generateAnalyzePrompt('zh', null, '数学');
        expect(single).toContain('<page_continuity>');
        expect(single).not.toContain('【多页图片】');
        const custom = generateAnalyzePrompt('zh', null, '化学', { customTemplate: '自定义模板 {{language_instruction}}', pageCount: 2 });
        expect(custom).toContain('【多页图片】');
        expect(custom).toContain('<page_continuity>');
    });

    it('张数只进系统规则，不进用户数据', () => {
        const request = generateAnalyzeRequest('zh', null, '物理', { pageCount: 3 });
        expect(request.system).toContain('共 3 张图片');
        expect(request.user).not.toContain('pageCount');
    });
});

describe('跨页题拼图', () => {
    async function page(width: number, height: number) {
        const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
        return normalizeImageBuffer(buffer);
    }

    it('竖长的页面左右并排，横长的页面上下拼接，最长边不超过上限', async () => {
        const portrait = await stitchImages([await page(600, 800), await page(600, 800)], { maxEdge: 1000, gap: 10 });
        expect(portrait.mimeType).toBe('image/jpeg');
        expect(portrait.width).toBeGreaterThan(portrait.height);
        expect(Math.max(portrait.width, portrait.height)).toBeLessThanOrEqual(1000);

        const strips = await stitchImages([await page(900, 200), await page(900, 300), await page(900, 250)], { maxEdge: 1000, gap: 10 });
        expect([strips.width, strips.height]).toEqual([900, 770]);
        const meta = await sharp(strips.buffer).metadata();
        expect([meta.width, meta.height]).toEqual([strips.width, strips.height]);
    });

    it('小图不放大', async () => {
        const result = await stitchImages([await page(100, 50), await page(100, 50)], { gap: 4 });
        expect(result.width).toBe(100);
        expect(result.height).toBe(104);
    });
});
