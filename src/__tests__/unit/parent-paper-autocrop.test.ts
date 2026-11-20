import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { autoCropPaperImage, detectPaperBounds } from "@/lib/parent-paper-autocrop";

describe("detectPaperBounds", () => {
    it("finds a light page on a dark table background", () => {
        const width = 200;
        const height = 300;
        const gray = Buffer.alloc(width * height, 50); // dark table
        for (let y = 80; y < 280; y++) {
            for (let x = 20; x < 190; x++) gray[y * width + x] = 200;
        }
        const crop = detectPaperBounds(gray, width, height);
        expect(crop).not.toBeNull();
        expect(crop!.y).toBeGreaterThan(0.15);
        expect(crop!.y).toBeLessThan(0.32);
        expect(crop!.y + crop!.height).toBeGreaterThan(0.9);
        expect(crop!.x).toBeLessThan(0.2);
        expect(crop!.x + crop!.width).toBeGreaterThan(0.85);
        expect(crop!.width * crop!.height).toBeGreaterThan(0.45);
        expect(crop!.width * crop!.height).toBeLessThan(0.9);
    });

    it("returns null when the whole frame is already the page", () => {
        const width = 100;
        const height = 100;
        const gray = Buffer.alloc(width * height, 200);
        expect(detectPaperBounds(gray, width, height)).toBeNull();
    });
});

describe("autoCropPaperImage", () => {
    it("crops a jpeg of a white page on a brown table and keeps EXIF-free output", async () => {
        const width = 240;
        const height = 360;
        const image = await sharp({
            create: {
                width,
                height,
                channels: 3,
                background: { r: 90, g: 55, b: 30 },
            },
        })
            .composite([{
                input: await sharp({
                    create: { width: 200, height: 260, channels: 3, background: { r: 245, g: 242, b: 235 } },
                }).png().toBuffer(),
                left: 20,
                top: 70,
            }])
            .jpeg()
            .toBuffer();

        const result = await autoCropPaperImage(`data:image/jpeg;base64,${image.toString("base64")}`);
        expect(result.cropped).toBe(true);
        expect(result.crop).not.toBeNull();
        expect(result.crop!.y).toBeGreaterThan(0.1);
        expect(result.imageUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
        expect(result.imageUrl).not.toBe(`data:image/jpeg;base64,${image.toString("base64")}`);

        const meta = await sharp(Buffer.from(result.imageUrl.split(",")[1], "base64")).metadata();
        expect((meta.height ?? 0)).toBeLessThan(height);
        expect((meta.width ?? 0)).toBeLessThanOrEqual(width);
        expect((meta.height ?? 0)).toBeGreaterThan(200);
    });

    it("returns the original when cropping is not needed or the input is invalid", async () => {
        const plain = await sharp({
            create: { width: 80, height: 80, channels: 3, background: { r: 240, g: 240, b: 240 } },
        }).jpeg().toBuffer();
        const dataUrl = `data:image/jpeg;base64,${plain.toString("base64")}`;
        const result = await autoCropPaperImage(dataUrl);
        expect(result.cropped).toBe(false);
        expect(result.imageUrl).toBe(dataUrl);
        const invalid = await autoCropPaperImage("https://example.com/page.jpg");
        expect(invalid.cropped).toBe(false);
    });
});
