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

    it("降权前修正持久化目录与私钥权限，并在非特权 8443 端口映射 HTTPS", () => {
        const script = readFileSync("docker-entrypoint.sh", "utf8");
        const dockerfile = readFileSync("Dockerfile", "utf8");
        const httpsServer = readFileSync("https-server.js", "utf8");
        const compose = readFileSync("docker-compose.https.yml", "utf8");

        expect(script).toContain('if [ "$(id -u)" = "0" ]');
        expect(script).toContain("chown -R nextjs:nodejs");
        expect(script).toContain("/app/data");
        expect(script).toContain("/app/config");
        expect(script).toContain("if openssl req -x509");
        expect(script).toContain('chmod 600 "$KEY_FILE"');
        expect(script).toContain('HTTPS_LISTEN_PORT="${HTTPS_PORT:-8443}"');

        expect(dockerfile).toContain("COPY --from=builder --chown=nextjs:nodejs /app/public ./public");
        expect(httpsServer).toContain("process.env.HTTPS_PORT || '8443'");
        expect(compose).toContain('"443:8443"');
    });
});
