import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compare } from "bcryptjs";
import { expect, it } from "vitest";
import { createIsolatedTestDb } from "../helpers/two-tenants";

it("运维脚本只读检查数据库，改密会撤销旧会话并返回正确的退出码", async () => {
    const { db, dbUrl, cleanup } = createIsolatedTestDb("database-scripts-");
    const run = (name: string, ...args: string[]) => spawnSync(process.execPath, [`scripts/${name}.js`, ...args], {
        env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8",
    });
    try {
        const empty = run("check-db-users");
        expect(empty.status).toBe(0);
        expect(empty.stdout).toContain("Users found: 0");
        expect(await db.user.count()).toBe(0);

        const email = "script-test@example.invalid";
        const original = randomUUID();
        const user = await db.user.create({ data: { email, password: original, authVersion: 3 } });
        const listing = run("check-db-users");
        expect(listing.stdout).toContain(email);
        expect(listing.stdout).not.toContain(original);

        for (const year of [2023, 2024, 2026, 2025]) {
            await db.errorItem.create({
                data: { userId: user.id, questionText: `fixture-${year}`, originalImageUrl: "", createdAt: new Date(Date.UTC(year, 0)) },
            });
        }
        const recent = run("check-db-data");
        expect(recent.status).toBe(0);
        expect(recent.stdout.match(/fixture-\d+/g)).toEqual(["fixture-2026", "fixture-2025", "fixture-2024"]);

        const password = randomUUID();
        expect(run("reset-password").status).toBe(1);
        expect(run("reset-password", "   ", password).status).toBe(1);
        expect(run("reset-password", email, "short").status).toBe(1);
        expect(run("reset-password", "absent@example.invalid", password).status).toBe(1);
        const reset = run("reset-password", `  ${email.toUpperCase()}  `, password);
        expect(reset.status).toBe(0);
        expect(reset.stdout).toContain(email);
        expect(reset.stdout + reset.stderr).not.toContain(password);
        const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(await compare(password, updated.password)).toBe(true);
        expect(updated.authVersion).toBe(4);

        // 兼容历史库中含大写字母的邮箱
        const mixedUser = await db.user.create({ data: { email: "MixedCase@Example.Invalid", password: original, authVersion: 1 } });
        const mixedReset = run("reset-password", "mixedcase@example.invalid", password);
        expect(mixedReset.status).toBe(0);
        expect((await db.user.findUniqueOrThrow({ where: { id: mixedUser.id } })).authVersion).toBe(2);
    } finally {
        await cleanup();
    }
}, 20_000);

it("模型诊断只向显式配置的服务发请求", () => {
    const invoke = 'globalThis.fetch = () => process.exit(2); require("./scripts/check-api-models.js")';
    const key = randomUUID();
    const result = spawnSync(process.execPath, ["-e", invoke], {
        env: { ...process.env, OPENAI_BASE_URL: "", OPENAI_API_KEY: key }, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAI_BASE_URL");
    expect(result.stderr + result.stdout).not.toContain(key);
});

it.each([
    ["credentials", "http://localhost:3100", "./scripts/test-openclaw.js"],
    ["apikey", "https://example.invalid/staging", "./scripts/test-openclaw-integration.js"],
])("Openclaw %s 认证仅发送给配置的诊断地址", (mode, target, entry) => {
    const credential = randomUUID();
    const probe = `
        const assert = require("node:assert/strict");
        globalThis.fetch = async (url, request) => {
            assert.equal(String(url), process.env.WRONG_NOTEBOOK_URL + "/api/openclaw/batch-upload");
            assert.equal(request.redirect, "error");
            const body = JSON.parse(request.body);
            assert.deepEqual(body.images, []);
            if (process.env.OPENCLAW_AUTH_MODE === "apikey") {
                assert.equal(request.headers["x-api-key"], process.env.OPENCLAW_INTEGRATION_API_KEY);
                assert.equal(body.userEmail, process.env.OPENCLAW_TEST_USER);
                assert.equal(body.password, undefined);
            } else {
                assert.equal(body.username, process.env.OPENCLAW_TEST_USER);
                assert.equal(body.password, process.env.OPENCLAW_TEST_PASSWORD);
                assert.equal(request.headers["x-api-key"], undefined);
            }
            return Response.json({details: "Missing images array"}, {status: 400});
        };
        require(process.argv[1]);
    `;
    const result = spawnSync(process.execPath, ["-e", probe, entry], {
        env: {
            ...process.env, WRONG_NOTEBOOK_URL: target, OPENCLAW_AUTH_MODE: mode, OPENCLAW_TEST_USER: "tester@example.invalid",
            OPENCLAW_INTEGRATION_API_KEY: credential, OPENCLAW_TEST_PASSWORD: credential,
        },
        encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("未提交图片");
    expect(result.stderr + result.stdout).not.toContain(credential);
});

it.skipIf(process.platform === "win32")("build-image.sh 校验传入提交与 HEAD 一致，并在脏工作树自动标记 -dirty", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "build-image-test-"));
    const outDir = mkdtempSync(path.join(tmpdir(), "build-image-out-"));
    try {
        mkdirSync(path.join(repo, "scripts"), { recursive: true });
        mkdirSync(path.join(repo, "bin"), { recursive: true });
        copyFileSync("scripts/build-image.sh", path.join(repo, "scripts/build-image.sh"));
        const dockerArgsFile = path.join(outDir, "docker.args");
        writeFileSync(
            path.join(repo, "bin/docker"),
            `#!/bin/sh\nprintf '%s\\n' "$@" > "${dockerArgsFile}"\n`,
            { mode: 0o755 },
        );

        const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
        expect(git("init", "-q").status).toBe(0);
        expect(git("config", "user.name", "Tester").status).toBe(0);
        expect(git("config", "user.email", "test@example.com").status).toBe(0);

        writeFileSync(path.join(repo, "tracked.txt"), "v1\n");
        expect(git("add", ".").status).toBe(0);
        expect(git("commit", "-qm", "init").status).toBe(0);
        const firstCommit = git("rev-parse", "HEAD").stdout.trim();

        writeFileSync(path.join(repo, "tracked.txt"), "v2\n");
        expect(git("add", "tracked.txt").status).toBe(0);
        expect(git("commit", "-qm", "second").status).toBe(0);
        const headCommit = git("rev-parse", "HEAD").stdout.trim();

        const runBuild = (...args: string[]) => spawnSync("bash", ["scripts/build-image.sh", ...args], {
            cwd: repo,
            env: { ...process.env, PATH: `${path.join(repo, "bin")}:${process.env.PATH ?? ""}` },
            encoding: "utf8",
        });

        const staleRef = runBuild(firstCommit);
        expect(staleRef.status).toBe(1);
        expect(existsSync(dockerArgsFile)).toBe(false);

        const clean = runBuild(headCommit);
        expect(clean.status).toBe(0);
        const cleanArgs = readFileSync(dockerArgsFile, "utf8").split("\n");
        expect(cleanArgs).toContain(`APP_REVISION=${headCommit}`);
        expect(cleanArgs).toContain(`wrong-notebook:${headCommit}`);

        writeFileSync(path.join(repo, "untracked.txt"), "new\n");
        const untrackedDirty = runBuild();
        expect(untrackedDirty.status).toBe(0);
        const untrackedArgs = readFileSync(dockerArgsFile, "utf8").split("\n");
        expect(untrackedArgs).toContain(`APP_REVISION=${headCommit}-dirty`);
        rmSync(path.join(repo, "untracked.txt"));

        writeFileSync(path.join(repo, "tracked.txt"), "v2-modified\n");
        const unstagedDirty = runBuild();
        expect(unstagedDirty.status).toBe(0);
        const unstagedArgs = readFileSync(dockerArgsFile, "utf8").split("\n");
        expect(unstagedArgs).toContain(`APP_REVISION=${headCommit}-dirty`);
        expect(unstagedArgs).toContain(`wrong-notebook:${headCommit}-dirty`);

        expect(git("add", "tracked.txt").status).toBe(0);
        const stagedDirty = runBuild("HEAD");
        expect(stagedDirty.status).toBe(0);
        const stagedArgs = readFileSync(dockerArgsFile, "utf8").split("\n");
        expect(stagedArgs).toContain(`APP_REVISION=${headCommit}-dirty`);
        expect(stagedArgs).toContain(`wrong-notebook:${headCommit}-dirty`);
    } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    }
});

it("build-docker 工作流与 ci.sh 包含公开历史检查、非 latest 默认值及完整语法覆盖", () => {
    const workflow = readFileSync(".github/workflows/build-docker.yml", "utf8");
    expect(workflow).toContain("publication-check:");
    expect(workflow).toContain("needs: publication-check");
    expect(workflow).toContain("python3 -m unittest discover -s tests/publication -v");
    expect(workflow).toContain("python3 scripts/check-public-history.py HEAD");
    expect(workflow).toContain("default: 'manual'");
    expect(workflow).toContain('"$INPUT_TAG" = "latest"');
    expect(workflow).toContain("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$");

    const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const e2eSection = ciWorkflow.slice(ciWorkflow.indexOf("e2e-test:"));
    expect(e2eSection).toContain("npx prisma generate");
    expect(e2eSection).not.toContain("http://127.0.0.1:3000");

    const ciScript = readFileSync("scripts/ci.sh", "utf8");
    expect(ciScript).toContain("scripts/start-e2e.js");
    expect(ciScript).toContain("src/lib/legacy-admin-password-hash.mjs");
});
