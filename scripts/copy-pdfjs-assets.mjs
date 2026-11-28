#!/usr/bin/env node
/**
 * 把 pdfjs-dist（Apache-2.0）的 worker、wasm 解码器、CMap 与标准字体复制到 public/pdfjs/<版本>/，
 * 由本站同源提供，不走 CDN。next dev / next build 前自动执行（predev / prebuild），产物不入库。
 * 旧版本目录会被清掉，避免 public 越积越大。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json", { paths: [repoRoot] }));
const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const outRoot = path.join(repoRoot, "public", "pdfjs");
const outDir = path.join(outRoot, version);

const entries = [
    ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
    ["wasm", "wasm"],
    ["cmaps", "cmaps"],
    ["standard_fonts", "standard_fonts"],
    ["LICENSE", "LICENSE"],
];

if (existsSync(outRoot)) {
    for (const name of readdirSync(outRoot)) {
        if (name !== version) rmSync(path.join(outRoot, name), { recursive: true, force: true });
    }
}
mkdirSync(outDir, { recursive: true });
for (const [from, to] of entries) {
    cpSync(path.join(pkgDir, from), path.join(outDir, to), { recursive: true, force: true });
}
console.log(`[pdfjs-assets] pdfjs-dist ${version} -> public/pdfjs/${version}/`);
