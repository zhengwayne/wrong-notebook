import { describe, expect, it } from "vitest";
import { badgeOffsets, badgePlacements, layoutParentPaperBBoxes, resolveOverlappingBBoxes } from "@/lib/parent-paper-box-layout";

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

    it("clips the left box even when the right-column box is slightly higher", () => {
        const [left, right] = resolveOverlappingBBoxes([
            { pageIndex: 0, x: 0.226, y: 0.39, width: 0.348, height: 0.125 },
            { pageIndex: 0, x: 0.536, y: 0.385, width: 0.388, height: 0.15 },
        ]);
        expect(left.x + left.width).toBeLessThanOrEqual(0.536);
        expect(right.x).toBeCloseTo(0.536, 3);
        expect(right.width).toBeCloseTo(0.388, 3);
    });

    it("clips a stacked box even when only a thin gap remains", () => {
        const [first, second] = resolveOverlappingBBoxes([
            { pageIndex: 0, x: 0.226, y: 0.835, width: 0.718, height: 0.065 },
            { pageIndex: 0, x: 0.226, y: 0.862, width: 0.718, height: 0.068 },
        ]);
        expect(first.y + first.height).toBeLessThanOrEqual(0.862);
        expect(second.y).toBeCloseTo(0.862, 3);
        expect(first.height).toBeGreaterThan(0);
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

describe("badgePlacements", () => {
    it("hangs badges to the left of mid-page fill-in lines so they do not cover the text", () => {
        const placements = badgePlacements([
            { id: "1", bbox: { pageIndex: 0, x: 0.216, y: 0.555, width: 0.728, height: 0.039 } },
            { id: "2", bbox: { pageIndex: 0, x: 0.216, y: 0.602, width: 0.728, height: 0.04 } },
            { id: "3", bbox: { pageIndex: 0, x: 0.216, y: 0.65, width: 0.728, height: 0.024 } },
        ]);
        expect(placements["1"].side).toBe("left");
        expect(placements["2"].side).toBe("left");
        expect(placements["3"].side).toBe("left");
        expect(placements["1"].shift).toBe(0);
    });

    it("moves a badge above the box when there is no left margin", () => {
        const placements = badgePlacements([
            { id: "edge", bbox: { pageIndex: 0, x: 0.01, y: 0.2, width: 0.4, height: 0.1 } },
        ]);
        expect(placements.edge.side).toBe("above");
    });
});
