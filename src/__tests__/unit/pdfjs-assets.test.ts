/**
 * pdf.js 同源静态资源：构建前脚本复制出 worker/wasm/CMap/字体，且 /pdfjs/ 不经登录拦截（未登录也能 200）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

describe("pdf.js 静态资源", () => {
    it("copy-pdfjs-assets 复制当前版本的 worker、wasm 解码器、CMap、标准字体和许可证", () => {
        execFileSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "pipe" });
        const { version } = JSON.parse(readFileSync("node_modules/pdfjs-dist/package.json", "utf8"));
        const dir = path.join("public/pdfjs", version);
        for (const file of ["pdf.worker.min.mjs", "wasm/openjpeg.wasm", "wasm/jbig2.wasm", "wasm/openjpeg_nowasm_fallback.js", "cmaps/UniGB-UCS2-H.bcmap", "standard_fonts/LiberationSans-Regular.ttf", "LICENSE"]) {
            expect(existsSync(path.join(dir, file)), file).toBe(true);
        }
        expect(readFileSync("package.json", "utf8")).toMatch(/"prebuild": "node scripts\/copy-pdfjs-assets\.mjs"/);
    });

    it("proxy 不拦截 /pdfjs/，但仍拦截普通页面", () => {
        const matcher = new RegExp(`^${config.matcher[0]}$`);
        expect(matcher.test("/pdfjs/6.5.438/pdf.worker.min.mjs")).toBe(false);
        expect(matcher.test("/grading/abc")).toBe(true);
    });
});
