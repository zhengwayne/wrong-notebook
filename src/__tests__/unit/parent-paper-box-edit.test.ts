import { describe, expect, it } from "vitest";
import { resizeNormalizedBox, regionToBBox } from "@/lib/parent-paper-box-edit";

const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.3 };

describe("resizeNormalizedBox", () => {
    it("moves a box and keeps it on the page", () => {
        const moved = resizeNormalizedBox(start, { x: 0.3, y: 0.3 }, { x: 0.4, y: 0.35 }, "move");
        expect(moved.x).toBeCloseTo(0.3);
        expect(moved.y).toBeCloseTo(0.25);
        expect(moved.width).toBeCloseTo(0.4);
        expect(moved.height).toBeCloseTo(0.3);
        const clamped = resizeNormalizedBox(start, { x: 0.2, y: 0.2 }, { x: 1, y: 1 }, "move");
        expect(clamped.x + clamped.width).toBeCloseTo(1);
        expect(clamped.y + clamped.height).toBeCloseTo(1);
    });

    it("resizes from corners and edges", () => {
        const se = resizeNormalizedBox(start, { x: 0.6, y: 0.5 }, { x: 0.7, y: 0.6 }, "se");
        expect(se.width).toBeCloseTo(0.5);
        expect(se.height).toBeCloseTo(0.4);
        const nw = resizeNormalizedBox(start, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.1 }, "nw");
        expect(nw.x).toBeCloseTo(0.1);
        expect(nw.y).toBeCloseTo(0.1);
        expect(nw.width).toBeCloseTo(0.5);
        expect(nw.height).toBeCloseTo(0.4);
    });

    it("does not shrink below the minimum size", () => {
        const tiny = resizeNormalizedBox(start, { x: 0.6, y: 0.5 }, { x: 0.2, y: 0.2 }, "se");
        expect(tiny.width).toBeGreaterThanOrEqual(0.02);
        expect(tiny.height).toBeGreaterThanOrEqual(0.02);
    });
});

describe("regionToBBox", () => {
    it("attaches the page index and clamps", () => {
        expect(regionToBBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 1)).toEqual({
            pageIndex: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4,
        });
        expect(regionToBBox({ x: 0.95, y: 0.95, width: 0.2, height: 0.2 }, 0)).toEqual({
            pageIndex: 0, x: 0.95, y: 0.95, width: 0.05, height: 0.05,
        });
    });
});
