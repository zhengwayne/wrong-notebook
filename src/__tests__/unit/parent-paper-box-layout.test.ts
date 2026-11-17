import { describe, expect, it } from "vitest";
import { badgeOffsets, layoutParentPaperBBoxes, resolveOverlappingBBoxes } from "@/lib/parent-paper-box-layout";

describe("resolveOverlappingBBoxes", () => {
    it("clips a left-column box so it does not cover the right-column question", () => {
        const [left, right] = resolveOverlappingBBoxes([
            { pageIndex: 0, x: 0.12, y: 0.25, width: 0.88, height: 0.2 },
            { pageIndex: 0, x: 0.5, y: 0.25, width: 0.45, height: 0.18 },
        ]);
        expect(left.x + left.width).toBeLessThanOrEqual(0.5);
        expect(right.x).toBeCloseTo(0.5, 3);
        expect(right.width).toBeCloseTo(0.45, 3);
    });

    it("clips a stacked full-width box so it ends before the next question", () => {
        const [first, second] = resolveOverlappingBBoxes([
            { pageIndex: 0, x: 0.1, y: 0.56, width: 0.85, height: 0.18 },
            { pageIndex: 0, x: 0.1, y: 0.62, width: 0.85, height: 0.16 },
        ]);
        expect(first.y + first.height).toBeLessThanOrEqual(0.62);
        expect(second.y).toBeCloseTo(0.62, 3);
        expect(first.height).toBeGreaterThan(0.02);
    });

    it("does not clip boxes on different pages", () => {
        const boxes = resolveOverlappingBBoxes([
            { pageIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
            { pageIndex: 1, x: 0.1, y: 0.2, width: 0.8, height: 0.4 },
        ]);
        expect(boxes[0].height).toBeCloseTo(0.4, 3);
        expect(boxes[1].height).toBeCloseTo(0.4, 3);
    });
});

describe("layoutParentPaperBBoxes", () => {
    it("keeps questions without a box unchanged", () => {
        const questions = [
            { number: "1", bbox: { pageIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.3 } },
            { number: "2", bbox: null },
        ];
        const laid = layoutParentPaperBBoxes(questions);
        expect(laid[1].bbox).toBeNull();
        expect(laid[0].bbox?.width).toBeCloseTo(0.8, 3);
    });
});

describe("badgeOffsets", () => {
    it("staggers badges that share nearly the same top-left corner", () => {
        const offsets = badgeOffsets([
            { id: "a", bbox: { pageIndex: 0, x: 0.1, y: 0.5, width: 0.8, height: 0.1 } },
            { id: "b", bbox: { pageIndex: 0, x: 0.11, y: 0.51, width: 0.8, height: 0.1 } },
        ]);
        expect(offsets.b).toBeGreaterThan(0);
        expect(offsets.a ?? 0).toBe(0);
    });
});
