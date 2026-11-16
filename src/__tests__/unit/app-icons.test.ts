import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../..');

function pngSize(rel: string) {
    const buf = readFileSync(join(root, rel));
    expect(buf.toString('ascii', 12, 16), `${rel} should be PNG`).toBe('IHDR');
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('应用图标', () => {
    it('PWA / 网页图标尺寸正确', () => {
        expect(pngSize('public/icons/icon.png')).toEqual({ width: 512, height: 512 });
        expect(pngSize('public/icons/icon-192.png')).toEqual({ width: 192, height: 192 });
        expect(pngSize('public/icons/icon-512.png')).toEqual({ width: 512, height: 512 });
        expect(pngSize('public/icons/icon-maskable-512.png')).toEqual({ width: 512, height: 512 });
        expect(pngSize('public/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    });

    it('提供 SVG 源文件且不含渐变', () => {
        const svg = readFileSync(join(root, 'src/app/icon.svg'), 'utf8');
        const publicSvg = readFileSync(join(root, 'public/icons/icon.svg'), 'utf8');
        expect(svg).toBe(publicSvg);
        expect(svg).toMatch(/viewBox="0 0 32 32"/);
        expect(svg).not.toMatch(/<(?:linear|radial)Gradient\b/i);
        expect(svg).not.toMatch(/gradientUnits|linear-gradient/i);
    });

    it('favicon.ico 含 16/32/48/256 多个尺寸', () => {
        const data = readFileSync(join(root, 'src/app/favicon.ico'));
        const count = data.readUInt16LE(4);
        expect(data.readUInt16LE(0)).toBe(0);
        expect(data.readUInt16LE(2)).toBe(1);
        expect(count).toBeGreaterThanOrEqual(4);
        const sizes = new Set<number>();
        for (let i = 0; i < count; i++) {
            const w = data.readUInt8(6 + i * 16);
            sizes.add(w === 0 ? 256 : w);
        }
        expect(sizes).toEqual(new Set([16, 32, 48, 256]));
    });

    it('Android 自适应图标背景为薰衣草主色，并提供启动图标', () => {
        const colors = readFileSync(
            join(root, 'packaging/android/app/src/main/res/values/colors.xml'),
            'utf8',
        );
        expect(colors).toMatch(/<color name="icon_background">#6b5ca5<\/color>/);
        expect(pngSize('packaging/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')).toEqual({
            width: 192,
            height: 192,
        });
        expect(pngSize('packaging/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png')).toEqual({
            width: 432,
            height: 432,
        });
        expect(existsSync(join(root, 'packaging/fnos/ICON.PNG'))).toBe(true);
        expect(pngSize('packaging/fnos/ICON_256.PNG')).toEqual({ width: 256, height: 256 });
    });
});
