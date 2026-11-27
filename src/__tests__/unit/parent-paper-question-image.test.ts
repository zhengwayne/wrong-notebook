import { describe, expect, it } from "vitest";
import { questionImageSource } from "@/lib/parent-papers";

const bbox = (pageIndex: number) => ({ pageIndex, x: 0.1, y: 0.2, width: 0.5, height: 0.3 });
const paper = {
    pages: [
        { id: "p2", position: 1, imageUrl: "data:image/jpeg;base64,BBB" },
        { id: "p1", position: 0, imageUrl: "data:image/jpeg;base64,AAA" },
    ],
    questions: [
        { id: "q1", bbox: bbox(1) },
        { id: "q2", bbox: null },
        { id: "q3", bbox: bbox(5) },
    ],
} as unknown as Parameters<typeof questionImageSource>[0];

describe("questionImageSource", () => {
    it("picks the page by position and keeps the box", () => {
        expect(questionImageSource(paper, "q1")).toEqual({ pageIndex: 1, imageUrl: "data:image/jpeg;base64,BBB", bbox: bbox(1) });
    });
    it("falls back to the first page without a box", () => {
        expect(questionImageSource(paper, "q2")).toEqual({ pageIndex: 0, imageUrl: "data:image/jpeg;base64,AAA", bbox: null });
        expect(questionImageSource(paper, "q3")).toEqual({ pageIndex: 0, imageUrl: "data:image/jpeg;base64,AAA", bbox: null });
    });
    it("returns null for an unknown question or a missing image", () => {
        expect(questionImageSource(paper, "nope")).toBeNull();
        expect(questionImageSource({ ...paper, pages: [] }, "q1")).toBeNull();
    });
});
