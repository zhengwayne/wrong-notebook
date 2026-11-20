import sharp from 'sharp';

/** 4x4 纯白 PNG 最小合法图片（无任何 EXIF/XMP 元数据） */
export const SAMPLE_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4jwQYiOMAANuQL9HsugRzAAAAAElFTkSuQmCC';

export const SAMPLE_PNG_DATA_URL = `data:image/png;base64,${SAMPLE_PNG_BASE64}`;

/** 4x4 纯白 JPEG 最小合法图片（无任何 EXIF/XMP 元数据） */
export const SAMPLE_JPEG_BASE64 =
    '/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALLAB//Z';

export const SAMPLE_JPEG_DATA_URL = `data:image/jpeg;base64,${SAMPLE_JPEG_BASE64}`;

/** 用 sharp 动态构造带有 EXIF GPS 与方向标记的真实测试 JPEG */
export async function createJpegWithExif(options: {
    width?: number;
    height?: number;
    orientation?: number;
} = {}): Promise<{ buffer: Buffer; dataUrl: string }> {
    const width = options.width ?? 16;
    const height = options.height ?? 10;
    const buffer = await sharp({
        create: { width, height, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
        .jpeg({ quality: 90 })
        .withMetadata({
            orientation: options.orientation ?? 6,
            exif: {
                IFD0: {
                    Make: 'TestPhone',
                    Model: 'TestCam-X',
                },
                IFD3: {
                    GPSLatitudeRef: 'N',
                    GPSLatitude: '31/1 14/1 10/1',
                    GPSLongitudeRef: 'E',
                    GPSLongitude: '121/1 28/1 20/1',
                },
            },
        })
        .toBuffer();

    return {
        buffer,
        dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    };
}
