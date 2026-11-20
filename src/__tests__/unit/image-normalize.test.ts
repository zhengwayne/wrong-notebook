import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
    DEFAULT_MAX_EDGE,
    ImageValidationError,
    normalizeImageBuffer,
    normalizeImageDataUrl,
    normalizeImageInput,
    normalizeOptionalImageDataUrl,
} from '@/lib/server/image-normalize';
import {
    createJpegWithExif,
    SAMPLE_JPEG_DATA_URL,
    SAMPLE_PNG_DATA_URL,
} from '../helpers/sample-images';

describe('服务端图片规范化 normalizeImage*', () => {
    it('按 EXIF 方向转正并彻底剥离 EXIF（含 GPS 位置信息）与元数据', async () => {
        // 构造宽 40 高 20，Orientation=6（旋转 90 度）且带 GPS EXIF 的真实 JPEG
        const { buffer, dataUrl } = await createJpegWithExif({ width: 40, height: 20, orientation: 6 });
        const beforeMeta = await sharp(buffer).metadata();
        expect(beforeMeta.exif).toBeDefined();
        expect(beforeMeta.orientation).toBe(6);

        const normalized = await normalizeImageDataUrl(dataUrl);
        expect(normalized.mimeType).toBe('image/jpeg');
        expect(normalized.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
        // 旋转后宽高互换，且 exif / xmp / iptc 元数据全部被剥离
        expect(normalized.width).toBe(20);
        expect(normalized.height).toBe(40);
        const afterMeta = await sharp(normalized.buffer).metadata();
        expect(afterMeta.exif).toBeUndefined();
        expect(afterMeta.iptc).toBeUndefined();
        expect(afterMeta.xmp).toBeUndefined();
        expect(afterMeta.orientation).toBeUndefined();
    });

    it('超大图最长边自动缩放到限制以内', async () => {
        const bigBuffer = await sharp({
            create: { width: 3200, height: 1600, channels: 3, background: '#ffffff' },
        }).png().toBuffer();

        const normalized = await normalizeImageBuffer(bigBuffer);
        expect(normalized.width).toBe(DEFAULT_MAX_EDGE);
        expect(normalized.height).toBe(DEFAULT_MAX_EDGE / 2);
        expect(normalized.mimeType).toBe('image/png');
    });

    it('拒绝 svg+xml、text/html、外链、伪造图片字节及不受支持的格式', async () => {
        await expect(normalizeImageDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).rejects.toThrow(ImageValidationError);
        await expect(normalizeImageDataUrl('data:text/html;base64,PGh0bWw+')).rejects.toThrow(ImageValidationError);
        await expect(normalizeImageDataUrl('javascript:alert(1)')).rejects.toThrow(ImageValidationError);
        await expect(normalizeImageDataUrl('https://evil.example/a.png')).rejects.toThrow(ImageValidationError);
        await expect(normalizeImageDataUrl('data:image/png;base64,dGVzdA==')).rejects.toThrow(ImageValidationError);

        const pngBuf = Buffer.from(SAMPLE_PNG_DATA_URL.split(',')[1], 'base64');
        await expect(normalizeImageBuffer(pngBuf, { allowedFormats: ['jpeg'] })).rejects.toThrow(ImageValidationError);
    });

    it('normalizeImageInput 支持裸 base64 与 data URL；normalizeOptionalImageDataUrl 允许空串', async () => {
        const rawJpgBase64 = SAMPLE_JPEG_DATA_URL.split(',')[1];
        const fromRaw = await normalizeImageInput(rawJpgBase64);
        expect(fromRaw.mimeType).toBe('image/jpeg');

        expect(await normalizeOptionalImageDataUrl('')).toBe('');
        expect(await normalizeOptionalImageDataUrl(null)).toBe('');
        expect(await normalizeOptionalImageDataUrl('   ')).toBe('');
        const nonEmpty = await normalizeOptionalImageDataUrl(SAMPLE_PNG_DATA_URL);
        expect(nonEmpty.startsWith('data:image/png;base64,')).toBe(true);
    });
});
