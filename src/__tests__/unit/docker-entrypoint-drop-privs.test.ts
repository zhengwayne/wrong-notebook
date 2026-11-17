import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("docker-entrypoint drop privileges", () => {
    it("用变量保存 gosu/su-exec，避免 POSIX exec 无法调用函数", () => {
        const script = readFileSync("docker-entrypoint.sh", "utf8");
        expect(script).toContain('DROP_PRIVS=gosu');
        expect(script).toContain('DROP_PRIVS=su-exec');
        expect(script).toContain('exec "$DROP_PRIVS" nextjs:nodejs "$@"');
        expect(script).not.toMatch(/exec\s+drop_privs\b/);
    });
});
