// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressImage, processImageFile, readJpegExifOrientation } from '@/lib/image-utils';

/** 构造含 APP1 EXIF Orientation 的极简 JPEG 字节 */
function buildJpegWithOrientation(orientation: number): Uint8Array {
    // SOI + APP1(Exif header + big-endian TIFF + 1 IFD tag 0x0112 Orientation) + EOI
    const buf = new Uint8Array(40);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 0xffd8, false); // SOI
    view.setUint16(2, 0xffe1, false); // APP1
    view.setUint16(4, 34, false); // APP1 length
    view.setUint32(6, 0x45786966, false); // "Exif"
    view.setUint16(10, 0x0000, false);
    const tiff = 12;
    view.setUint16(tiff, 0x4d4d, false); // "MM" big endian
    view.setUint16(tiff + 2, 42, false);
    view.setUint32(tiff + 4, 8, false); // IFD0 offset
    const ifd0 = tiff + 8;
    view.setUint16(ifd0, 1, false); // 1 entry
    view.setUint16(ifd0 + 2, 0x0112, false); // Orientation tag
    view.setUint16(ifd0 + 4, 3, false); // SHORT
    view.setUint32(ifd0 + 6, 1, false); // count
    view.setUint16(ifd0 + 10, orientation, false); // value
    view.setUint16(38, 0xffd9, false); // EOI
    return buf;
}

describe('image-utils 白底填充与小图规范化 (OPT-15)', () => {
    const drawOps: Array<{ type: string; fillStyle?: string }> = [];
    let mockBitmapSize = { width: 800, height: 600 };

    beforeEach(() => {
        drawOps.length = 0;
        mockBitmapSize = { width: 800, height: 600 };

        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            width: mockBitmapSize.width,
            height: mockBitmapSize.height,
            close: vi.fn(),
        })));

        const mockCtx = {
            _fillStyle: '',
            set fillStyle(val: string) {
                this._fillStyle = val;
            },
            get fillStyle() {
                return this._fillStyle;
            },
            fillRect: vi.fn(function (this: { _fillStyle: string }) {
                drawOps.push({ type: 'fillRect', fillStyle: this._fillStyle });
            }),
            drawImage: vi.fn(() => {
                drawOps.push({ type: 'drawImage' });
            }),
        };

        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/WHITEBG');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('compressImage 导出 JPEG 前在 Canvas 先填充纯白底 #ffffff，再绘制图像', async () => {
        const png = new File([new Uint8Array([137, 80, 78, 71])], 'transparent.png', { type: 'image/png' });
        const result = await compressImage(png);

        expect(result).toBe('data:image/jpeg;base64,/9j/WHITEBG');
        expect(drawOps).toEqual([
            { type: 'fillRect', fillStyle: '#ffffff' },
            { type: 'drawImage' },
        ]);
    });

    it('小于 1MB 的透明 PNG 仍走白底规范化转换，不会原样透传', async () => {
        const smallPng = new File([new Uint8Array([137, 80, 78, 71, 0, 1])], 'small.png', { type: 'image/png' });
        const result = await processImageFile(smallPng);

        expect(result).toBe('data:image/jpeg;base64,/9j/WHITEBG');
        expect(drawOps[0]).toEqual({ type: 'fillRect', fillStyle: '#ffffff' });
    });

    it('小于 1MB 但超宽或含 EXIF Orientation > 1 的 JPEG 仍会规范化，正常小图直接读取 DataURL', async () => {
        const orientedJpeg = new File([Buffer.from(buildJpegWithOrientation(6))], 'rotated.jpg', { type: 'image/jpeg' });
        expect(await readJpegExifOrientation(orientedJpeg)).toBe(6);

        const orientedOut = await processImageFile(orientedJpeg);
        expect(orientedOut).toBe('data:image/jpeg;base64,/9j/WHITEBG');
        expect(drawOps.length).toBe(2);

        // 正常方向但超宽 > 1920px 的小 JPEG
        drawOps.length = 0;
        mockBitmapSize = { width: 2400, height: 1200 };
        const wideJpeg = new File([Buffer.from(buildJpegWithOrientation(1))], 'wide.jpg', { type: 'image/jpeg' });
        const wideOut = await processImageFile(wideJpeg);
        expect(wideOut).toBe('data:image/jpeg;base64,/9j/WHITEBG');

        // 正常方向且 <= 1920px 的小 JPEG：不触发 Canvas 重绘，直接保留原文件 DataURL
        drawOps.length = 0;
        mockBitmapSize = { width: 1000, height: 800 };
        const normalJpeg = new File([Buffer.from(buildJpegWithOrientation(1))], 'normal.jpg', { type: 'image/jpeg' });
        const normalOut = await processImageFile(normalJpeg);
        expect(normalOut.startsWith('data:image/jpeg;base64,')).toBe(true);
        expect(normalOut).not.toBe('data:image/jpeg;base64,/9j/WHITEBG');
        expect(drawOps).toHaveLength(0);
    });
});
