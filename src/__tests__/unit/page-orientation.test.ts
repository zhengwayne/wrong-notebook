import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
    detectContentRotationFromGray,
    inkProjectionScores,
    type GrayImage,
} from "@/lib/page-orientation";
import { detectContentRotation, uprightImageDataUrl } from "@/lib/server/page-orientation";
import { createJpegWithExif } from "../helpers/sample-images";

async function horizontalLinePage(width = 200, height = 280): Promise<Buffer> {
    const raw = Buffer.alloc(width * height, 255);
    for (let y = Math.round(height * 0.22); y < height * 0.92; y += 10) {
        for (let dy = 0; dy < 5; dy += 1) {
            const row = y + dy;
            if (row >= height) continue;
            raw.fill(20, row * width + 16, row * width + (width - 16));
        }
    }
    return sharp(raw, { raw: { width, height, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();
}

async function grayFrom(buffer: Buffer): Promise<GrayImage> {
    const { data, info } = await sharp(buffer)
        .resize({ width: 512, height: 512, fit: "inside" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { pixels: new Uint8Array(data), width: info.width, height: info.height };
}

describe("detectContentRotationFromGray", () => {
    it("keeps an upright page with horizontal text lines at 0°", async () => {
        const gray = await grayFrom(await horizontalLinePage());
        expect(inkProjectionScores(gray).rowOverCol).toBeGreaterThan(1.5);
        expect(detectContentRotationFromGray(gray)).toBe(0);
    });

    it("returns 270° when an upright page was rotated 90° clockwise", async () => {
        const upright = await horizontalLinePage();
        const sideways = await sharp(upright).rotate(90).jpeg().toBuffer();
        const gray = await grayFrom(sideways);
        expect(detectContentRotationFromGray(gray)).toBe(270);
    });

    it("returns 90° when an upright page was rotated 90° counter-clockwise", async () => {
        const upright = await horizontalLinePage();
        const sideways = await sharp(upright).rotate(270).jpeg().toBuffer();
        const gray = await grayFrom(sideways);
        expect(detectContentRotationFromGray(gray)).toBe(90);
    });

    it("returns 180° for an upside-down page with more ink in the upper half", async () => {
        const upright = await horizontalLinePage();
        const flipped = await sharp(upright).rotate(180).jpeg().toBuffer();
        expect(detectContentRotationFromGray(await grayFrom(flipped))).toBe(180);
    });

    it("keeps a half-filled upright worksheet with blank lower half at 0° instead of flipping 180°", async () => {
        const width = 200, height = 280;
        const raw = Buffer.alloc(width * height, 255);
        for (let y = 30; y < 120; y += 10) {
            for (let dy = 0; dy < 5; dy += 1) raw.fill(20, (y + dy) * width + 16, (y + dy) * width + (width - 16));
        }
        const halfFilled = await sharp(raw, { raw: { width, height, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();
        expect(detectContentRotationFromGray(await grayFrom(halfFilled))).toBe(0);
    });

    it("does not enlarge tiny images past MIN_SIDE during content orientation check", async () => {
        const tiny = await sharp({
            create: { width: 24, height: 16, channels: 3, background: "#ffffff" },
        }).jpeg().toBuffer();
        expect(await detectContentRotation(tiny)).toBe(0);
    });

    it("does not rotate a nearly blank page", async () => {
        const blank = await sharp({
            create: { width: 160, height: 220, channels: 3, background: "#ffffff" },
        }).jpeg().toBuffer();
        expect(detectContentRotationFromGray(await grayFrom(blank))).toBe(0);
    });
});

describe("uprightImageDataUrl", () => {
    it("applies EXIF rotation first, then leaves an already-upright frame unrotated", async () => {
        // 40x20 + orientation 6 → normalize 后应为 20x40；内容接近纯色，不应再被内容检测扭转
        const { dataUrl, buffer } = await createJpegWithExif({ width: 40, height: 20, orientation: 6 });
        const before = await sharp(buffer).metadata();
        expect(before.orientation).toBe(6);
        const upright = await uprightImageDataUrl(dataUrl);
        expect(upright.contentRotation).toBe(0);
        expect(upright.width).toBe(20);
        expect(upright.height).toBe(40);
        const after = await sharp(upright.buffer).metadata();
        expect(after.orientation).toBeUndefined();
        expect(after.exif).toBeUndefined();
    });

    it("rotates a sideways worksheet so the stored frame matches the reading orientation", async () => {
        const upright = await horizontalLinePage(200, 280);
        const sideways = await sharp(upright).rotate(90).jpeg().toBuffer();
        expect(await detectContentRotation(sideways)).toBe(270);
        const dataUrl = `data:image/jpeg;base64,${sideways.toString("base64")}`;
        const result = await uprightImageDataUrl(dataUrl);
        expect(result.contentRotation).toBe(270);
        expect(result.height).toBeGreaterThan(result.width);
        expect(await detectContentRotation(result.buffer)).toBe(0);
        const meta = await sharp(result.buffer).metadata();
        expect(meta.orientation).toBeUndefined();
    });
});
