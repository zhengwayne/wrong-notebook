import { describe, expect, it } from "vitest";
import { transformNormalizedBBox, type ClockwiseRotation } from "@/lib/parent-paper-bbox";
import type { QuestionBBox } from "@/lib/parent-paper-review";

const box: QuestionBBox = { pageIndex: 0, x: 0.2, y: 0.1, width: 0.5, height: 0.2 };

describe("transformNormalizedBBox", () => {
    it("keeps the box unchanged at 0 degrees", () => {
        expect(transformNormalizedBBox(box, 0)).toEqual(box);
    });

    it("maps a horizontal box to a vertical box after 90° clockwise", () => {
        const rotated = transformNormalizedBBox(box, 90);
        expect(rotated.pageIndex).toBe(0);
        expect(rotated.x).toBeCloseTo(1 - 0.1 - 0.2);
        expect(rotated.y).toBeCloseTo(0.2);
        expect(rotated.width).toBeCloseTo(0.2);
        expect(rotated.height).toBeCloseTo(0.5);
    });

    it("270° clockwise matches a 90° counter-clockwise mapping", () => {
        const rotated = transformNormalizedBBox(box, 270);
        expect(rotated.x).toBeCloseTo(0.1);
        expect(rotated.y).toBeCloseTo(1 - 0.2 - 0.5);
        expect(rotated.width).toBeCloseTo(0.2);
        expect(rotated.height).toBeCloseTo(0.5);
    });

    it("returns to the original coordinate frame after four 90° turns", () => {
        let current = box;
        const steps: ClockwiseRotation[] = [90, 90, 90, 90];
        for (const step of steps) current = transformNormalizedBBox(current, step);
        expect(current.x).toBeCloseTo(box.x);
        expect(current.y).toBeCloseTo(box.y);
        expect(current.width).toBeCloseTo(box.width);
        expect(current.height).toBeCloseTo(box.height);
        expect(current.pageIndex).toBe(box.pageIndex);
    });
});
