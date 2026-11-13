import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SRC_ROOT = join(__dirname, "../..");
const EXTENSIONS = new Set([".css", ".ts", ".tsx", ".js", ".jsx"]);

/** 把模式拆开，避免本测试文件自己被扫到 */
const PATTERNS: { name: string; re: RegExp }[] = [
    { name: "bg-gradient", re: /bg-gradient(?:-to-[trbl]{1,2})?/ },
    { name: "linear-gradient()", re: /linear-gradient\s*\(/ },
    { name: "radial-gradient()", re: /radial-gradient\s*\(/ },
    { name: "conic-gradient()", re: /conic-gradient\s*\(/ },
    { name: "repeating-gradient()", re: /repeating-(?:linear|radial|conic)-gradient\s*\(/ },
    { name: "svg linearGradient", re: /<linearGradient\b/i },
    { name: "svg radialGradient", re: /<radialGradient\b/i },
];

function walk(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, files);
        else if (EXTENSIONS.has(extname(full))) files.push(full);
    }
    return files;
}

describe("源码中不应再出现渐变", () => {
    it("src 下没有 Tailwind / CSS / SVG 渐变用法", () => {
        const hits: string[] = [];
        for (const file of walk(SRC_ROOT)) {
            if (file.endsWith("no-gradients.test.ts")) continue;
            const lines = readFileSync(file, "utf8").split("\n");
            lines.forEach((line, index) => {
                for (const { name, re } of PATTERNS) {
                    if (re.test(line)) {
                        hits.push(`${relative(SRC_ROOT, file)}:${index + 1} (${name}) ${line.trim()}`);
                    }
                }
            });
        }
        expect(hits, hits.join("\n")).toEqual([]);
    });
});
