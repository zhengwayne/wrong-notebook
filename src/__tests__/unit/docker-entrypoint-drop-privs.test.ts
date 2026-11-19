import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function setupEntrypointSandbox(prefix: string, options: { prismaExitCode?: number; appVersion?: string; idUid?: string; chownExitCode?: number } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    for (const dir of ["bin", "config", "data", "prisma", "custom", "dist-scripts/scripts", "node_modules/prisma/build"]) {
        mkdirSync(path.join(root, dir), { recursive: true });
    }
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: options.appVersion ?? "1.0.0" }));
    writeFileSync(path.join(root, "bin/gosu"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(path.join(root, "bin/chown"), `#!/bin/sh\nexit ${options.chownExitCode ?? 0}\n`, { mode: 0o755 });
    if (options.idUid !== undefined) {
        writeFileSync(path.join(root, "bin/id"), `#!/bin/sh\necho "${options.idUid}"\n`, { mode: 0o755 });
    }
    writeFileSync(path.join(root, "node_modules/prisma/build/index.js"), `process.exit(${options.prismaExitCode ?? 0})`);
    writeFileSync(path.join(root, "dist-scripts/scripts/rebuild-system-tags.js"), 'require("node:fs").writeFileSync("rebuilt.flag", "1");');
    copyFileSync("packaging/runtime/launcher.js", path.join(root, "launcher.js"));
    writeFileSync(
        path.join(root, "entrypoint.sh"),
        readFileSync("docker-entrypoint.sh", "utf8").replaceAll("/app/", root + "/").replace("cd /app\n", `cd "${root}"\n`),
    );
    return root;
}

describe("docker-entrypoint drop privileges", () => {
    it.skipIf(process.platform === "win32").each(["absolute", "relative"])("%s 自定义数据库迁移失败时，备份写入数据库所在目录的 backups 子目录", mode => {
        const root = setupEntrypointSandbox("entrypoint-db-", { prismaExitCode: 1 });
        try {
            const database = path.join(root, "custom", "tenant.db");
            const url = "file:" + (mode === "absolute" ? database : "../custom/tenant.db") + "?connection_limit=1";
            writeFileSync(database, "用户选择的数据库");
            writeFileSync(path.join(root, "data/dev.db"), "默认数据库");
            const result = spawnSync("sh", ["entrypoint.sh", "true"], {
                cwd: root, env: { ...process.env, DATABASE_URL: url, PATH: path.join(root, "bin") + ":" + process.env.PATH },
                encoding: "utf8",
            });
            expect(result.status).toBe(1);
            const backupsDir = path.join(root, "custom/backups");
            const backups = readdirSync(backupsDir);
            expect(backups).toHaveLength(1);
            expect(result.stderr).toContain(path.join(backupsDir, backups[0]));
            expect(readFileSync(path.join(backupsDir, backups[0]), "utf8")).toBe("用户选择的数据库");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === "win32")("自定义数据库兼容读取 /app/data/.app_version 并在升级后把新版本写入 $DB_DIR/.app_version", () => {
        const root = setupEntrypointSandbox("entrypoint-version-", { prismaExitCode: 0, appVersion: "2.0.0" });
        try {
            const database = path.join(root, "custom", "tenant.db");
            writeFileSync(database, "已存在的自定义数据库");
            writeFileSync(path.join(root, "data/.app_version"), "2.0.0\n");

            const sameVersion = spawnSync("sh", ["entrypoint.sh", "true"], {
                cwd: root,
                env: { ...process.env, DATABASE_URL: `file:${database}`, PRESERVE_EXISTING_DATA: "false", PATH: path.join(root, "bin") + ":" + process.env.PATH },
                encoding: "utf8",
            });
            expect(sameVersion.status).toBe(0);
            expect(sameVersion.stdout).not.toContain("Version upgrade detected");

            writeFileSync(path.join(root, "data/.app_version"), "1.0.0\n");
            const upgrade = spawnSync("sh", ["entrypoint.sh", "true"], {
                cwd: root,
                env: { ...process.env, DATABASE_URL: `file:${database}`, PRESERVE_EXISTING_DATA: "false", PATH: path.join(root, "bin") + ":" + process.env.PATH },
                encoding: "utf8",
            });
            expect(upgrade.status).toBe(0);
            expect(upgrade.stdout).toContain("Version upgrade detected: 1.0.0 -> 2.0.0");
            expect(readFileSync(path.join(root, "custom/.app_version"), "utf8").trim()).toBe("2.0.0");
            expect(readFileSync(path.join(root, "data/.app_version"), "utf8").trim()).toBe("1.0.0");
            expect(readFileSync(path.join(root, "rebuilt.flag"), "utf8")).toBe("1");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === "win32")("非 root 身份启动时跳过 chown，不因无权限更改属主而失败", () => {
        const root = setupEntrypointSandbox("entrypoint-nonroot-", { prismaExitCode: 0, idUid: "1001", chownExitCode: 99 });
        try {
            const database = path.join(root, "data", "dev.db");
            writeFileSync(database, "已有默认数据库");
            const result = spawnSync("sh", ["entrypoint.sh", "true"], {
                cwd: root,
                env: { ...process.env, DATABASE_URL: `file:${database}`, PATH: path.join(root, "bin") + ":" + process.env.PATH },
                encoding: "utf8",
            });
            expect(result.status).toBe(0);
            expect(readdirSync(path.join(root, "data/backups"))).toHaveLength(1);
            expect(readFileSync(path.join(root, "data/.app_version"), "utf8").trim()).toBe("1.0.0");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("构建上下文只接收 Prisma 源文件，不携带本机配置与备份", () => {
        const rules = readFileSync(".dockerignore", "utf8").split(/\r?\n/);
        expect(rules).toEqual(expect.arrayContaining(["config", "data", "certs", "outputs", "prisma/*"]));
        expect(rules.slice(rules.indexOf("prisma/*") + 1).filter(rule => rule.startsWith("!prisma/"))).toEqual([
            "!prisma/schema.prisma", "!prisma/seed.ts", "!prisma/migrations",
        ]);
        const dockerfile = readFileSync("Dockerfile", "utf8");
        expect(dockerfile).not.toMatch(/^COPY .*\/app\/(?:prisma|config) \.\//m);
        expect(dockerfile).toContain("/app/prisma/dev.db /app/prisma/schema.prisma ./prisma/");
        expect(dockerfile).toContain("/app/prisma/migrations ./prisma/migrations");
    });

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
