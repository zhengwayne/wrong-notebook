import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("prisma binaryTargets", () => {
    it("包含 Debian 与 musl 的 OpenSSL 3 引擎，供 glibc 生产镜像和 Alpine 构建使用", () => {
        const schema = readFileSync("prisma/schema.prisma", "utf8");
        expect(schema).toMatch(/binaryTargets\s*=\s*\[/);
        expect(schema).toContain("debian-openssl-3.0.x");
        expect(schema).toContain("linux-musl-openssl-3.0.x");
    });
});
