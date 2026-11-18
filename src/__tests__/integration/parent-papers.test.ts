// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createJpegWithExif, SAMPLE_JPEG_DATA_URL } from "../helpers/sample-images";

const IMAGE = SAMPLE_JPEG_DATA_URL;

const mocks = vi.hoisted(() => ({
    prisma: undefined as PrismaClient | undefined,
    session: { user: { id: "parent-1", email: "parent-papers@example.com", role: "user" }, expires: "2099-01-01" },
}));

vi.mock("@/lib/prisma", () => ({ get prisma() { return mocks.prisma; } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/current-user", () => ({
    getCurrentUser: async () => mocks.prisma!.user.findUnique({ where: { email: mocks.session.user.email } }),
}));

import { GET, POST } from "@/app/api/parent/papers/route";

let directory: string;
let db: PrismaClient;

beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "parent-papers-"));
    const url = `file:${join(directory, "test.db")}`;
    execFileSync(process.execPath, [resolve("node_modules/prisma/build/index.js"), "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
    });
    db = new PrismaClient({ datasources: { db: { url } } });
    mocks.prisma = db;
}, 120000);

afterAll(async () => {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
    await db.parentPaperPage.deleteMany();
    await db.parentPaper.deleteMany();
    await db.learner.deleteMany();
    await db.user.deleteMany();
    await db.user.create({
        data: {
            id: "parent-1",
            email: mocks.session.user.email,
            password: "test-only",
            personas: "[\"parent\"]",
            activePersona: "parent",
            personasConfirmedAt: new Date(),
        },
    });
    await db.learner.createMany({ data: [
        { id: "child-a", userId: "parent-1", kind: "child", name: "小明", order: 0 },
        { id: "child-b", userId: "parent-1", kind: "child", name: "小红", order: 1 },
    ] });
});

describe("parent papers API", () => {
    it("saves a draft paper for the current child as pending recognition", async () => {
        const created = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                learnerId: "child-a",
                title: "小明的数学卷",
                pages: [{ imageUrl: IMAGE }, { imageUrl: IMAGE }],
            }),
        }));
        expect(created.status).toBe(201);
        const paper = await created.json();
        expect(paper).toMatchObject({
            learnerId: "child-a",
            learnerName: "小明",
            title: "小明的数学卷",
            status: "pending_recognition",
            pageCount: 2,
        });
        expect(paper.pages).toHaveLength(2);

        const listed = await GET(new Request("http://localhost/api/parent/papers?learnerId=child-a"));
        const data = await listed.json();
        expect(data.papers).toHaveLength(1);
        expect(data.papers[0].status).toBe("pending_recognition");

        const other = await GET(new Request("http://localhost/api/parent/papers?learnerId=child-b"));
        expect((await other.json()).papers).toHaveLength(0);
    });

    it("accepts subjectKey 语文 and rejects unknown subjects", async () => {
        const created = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                learnerId: "child-a",
                title: "乐一语文练习",
                subjectKey: "chinese",
                pages: [{ imageUrl: IMAGE }],
            }),
        }));
        expect(created.status).toBe(201);
        const paper = await created.json();
        expect(paper.subjectKey).toBe("chinese");
        const row = await db.parentPaper.findFirstOrThrow({ where: { id: paper.id } });
        expect(row.subjectKey).toBe("chinese");

        const invalid = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                learnerId: "child-a",
                subjectKey: "french",
                pages: [{ imageUrl: IMAGE }],
            }),
        }));
        expect(invalid.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects empty pages, invalid images, and another users child", async () => {
        const empty = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ learnerId: "child-a", pages: [] }),
        }));
        expect(empty.status).toBeGreaterThanOrEqual(400);

        const invalid = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ learnerId: "child-a", pages: [{ imageUrl: "https://example.com/a.jpg" }] }),
        }));
        expect(invalid.status).toBe(400);

        await db.user.create({ data: { id: "other", email: "other@example.com", password: "x" } });
        await db.learner.create({ data: { id: "child-other", userId: "other", kind: "child", name: "别人", order: 0 } });
        const stolen = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ learnerId: "child-other", pages: [{ imageUrl: IMAGE }] }),
        }));
        expect(stolen.status).toBe(404);
    });

    it("strips EXIF metadata including GPS from saved paper pages", async () => {
        const withExif = await createJpegWithExif({ width: 32, height: 24, orientation: 6 });
        const created = await POST(new Request("http://localhost/api/parent/papers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                learnerId: "child-a",
                title: "含EXIF试卷",
                pages: [{ imageUrl: withExif.dataUrl }],
            }),
        }));
        expect(created.status).toBe(201);
        const row = await db.parentPaperPage.findFirstOrThrow();
        for (const stored of [row.imageUrl, row.originalImageUrl].filter(Boolean) as string[]) {
            const meta = await sharp(Buffer.from(stored.split(",")[1], "base64")).metadata();
            expect(meta.exif).toBeUndefined();
        }
    });
});
