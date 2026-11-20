import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { cropDataUrlRegion } from "@/lib/parent-paper-crop";
import { boxPixelRect } from "@/lib/parent-paper-annotate";

async function solidJpeg(width: number, height: number, color: { r: number; g: number; b: number }) {
    const buffer = await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

describe("cropDataUrlRegion", () => {
    it("crops a region with sharp and returns a smaller jpeg", async () => {
        const source = await solidJpeg(200, 100, { r: 240, g: 240, b: 255 });
        const result = await cropDataUrlRegion(source, { x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
        expect(result.cropped).toBe(true);
        expect(result.imageUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
        const cropped = Buffer.from(result.imageUrl.split(",")[1], "base64");
        const meta = await sharp(cropped).metadata();
        expect(meta.width).toBe(100);
        expect(meta.height).toBe(40);
        expect(cropped.length).toBeLessThan(Buffer.from(source.split(",")[1], "base64").length);
    });

    it("falls back to the full page when the image is not a usable data URL", async () => {
        const fallback = await cropDataUrlRegion("https://example.com/page.jpg", { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
        expect(fallback).toEqual({ imageUrl: "https://example.com/page.jpg", cropped: false });
        const invalid = await cropDataUrlRegion("data:image/jpeg;base64,AAAA", { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
        expect(invalid).toEqual({ imageUrl: "data:image/jpeg;base64,AAAA", cropped: false });
    });

    it("falls back when extract fails", async () => {
        const source = await solidJpeg(40, 40, { r: 200, g: 200, b: 220 });
        const spy = vi.spyOn(sharp.prototype, "extract").mockImplementation(() => {
            throw new Error("extract failed");
        });
        const result = await cropDataUrlRegion(source, { x: 0.1, y: 0.1, width: 0.4, height: 0.4 });
        spy.mockRestore();
        expect(result).toEqual({ imageUrl: source, cropped: false });
    });
});

describe("boxPixelRect", () => {
    it("converts a normalized box to pixel rectangles", () => {
        expect(boxPixelRect({ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, 200, 100)).toEqual({
            x: 20, y: 20, w: 100, h: 25,
        });
    });
});
