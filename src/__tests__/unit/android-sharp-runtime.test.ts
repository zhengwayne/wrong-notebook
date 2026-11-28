import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve('.');

interface AndroidSharpRuntimeModule {
    prepareAndroidServerTree: (opts: {
        bundleDir: string;
        serverDir: string;
        rootNodeModulesDir?: string;
        licensesDir?: string;
    }) => void;
}

describe('android sharp-wasm32 runtime packaging & execution', () => {
    it('prepareAndroidServerTree removes native @img/* & build-host Prisma engines while bundling @img/sharp-wasm32 and @emnapi/runtime', async () => {
        const mod = (await import('../../../scripts/package/android-runtime.mjs')) as unknown as AndroidSharpRuntimeModule;
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'android-sharp-tree-'));
        try {
            const bundleDir = path.join(tmp, 'bundle');
            const serverDir = path.join(tmp, 'server');
            const licensesDir = path.join(tmp, 'licenses');

            // 模拟 dist/bundle 内遗留的构建机 Prisma 引擎与平台原生 sharp 包
            fs.mkdirSync(path.join(bundleDir, 'node_modules', '.prisma', 'client'), { recursive: true });
            fs.mkdirSync(path.join(bundleDir, 'node_modules', '@prisma', 'engines'), { recursive: true });
            fs.mkdirSync(path.join(bundleDir, 'node_modules', '@img', 'sharp-linux-x64'), { recursive: true });
            fs.mkdirSync(path.join(bundleDir, 'node_modules', '@img', 'sharp-libvips-linux-x64'), { recursive: true });
            fs.mkdirSync(path.join(bundleDir, 'node_modules', '@img', 'sharp-darwin-arm64'), { recursive: true });
            fs.mkdirSync(path.join(bundleDir, 'node_modules', '@img', 'colour'), { recursive: true });

            fs.writeFileSync(path.join(bundleDir, 'launcher.js'), '// launcher');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '.prisma', 'client', 'index.js'), 'module.exports = {};');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'), 'elf');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '@prisma', 'engines', 'schema-engine-debian-openssl-3.0.x'), 'elf');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '@img', 'sharp-linux-x64', 'package.json'), '{"name":"@img/sharp-linux-x64"}');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '@img', 'sharp-libvips-linux-x64', 'package.json'), '{"name":"@img/sharp-libvips-linux-x64"}');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '@img', 'sharp-darwin-arm64', 'package.json'), '{"name":"@img/sharp-darwin-arm64"}');
            fs.writeFileSync(path.join(bundleDir, 'node_modules', '@img', 'colour', 'package.json'), '{"name":"@img/colour"}');

            mod.prepareAndroidServerTree({
                bundleDir,
                serverDir,
                rootNodeModulesDir: path.join(REPO_ROOT, 'node_modules'),
                licensesDir,
            });

            // 1. 构建机 Prisma 引擎与平台原生 sharp 包已被清除
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'))).toBe(false);
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@prisma', 'engines', 'schema-engine-debian-openssl-3.0.x'))).toBe(false);
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@img', 'sharp-linux-x64'))).toBe(false);
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@img', 'sharp-libvips-linux-x64'))).toBe(false);
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@img', 'sharp-darwin-arm64'))).toBe(false);

            // 2. sharp-wasm32、@emnapi/runtime、@img/colour 及许可证完整就位
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@img', 'colour', 'package.json'))).toBe(true);
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@img', 'sharp-wasm32', 'package.json'))).toBe(true);
            expect(fs.existsSync(path.join(serverDir, 'node_modules', '@emnapi', 'runtime', 'package.json'))).toBe(true);
            expect(fs.existsSync(path.join(licensesDir, 'sharp-wasm32-LICENSE.txt'))).toBe(true);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('runs normalizeImageBuffer, autoCropPaperImage, and cropDataUrlRegion purely via @img/sharp-wasm32 when native addons are blocked', () => {
        const probeScript = `
            const fs = require('node:fs');
            const path = require('node:path');
            const assert = require('node:assert/strict');
            const Module = require('node:module');
            const ts = require(${JSON.stringify(require.resolve('typescript'))});
            const repoRoot = ${JSON.stringify(REPO_ROOT)};

            const loadedImgModules = [];
            const isBlockedNativeImg = (id) =>
                /^@img\\/sharp-(?!wasm32)/.test(id) || /^@img\\/sharp-libvips/.test(id);

            Module.registerHooks({
                resolve(specifier, context, nextResolve) {
                    if (isBlockedNativeImg(specifier)) {
                        throw new Error('Blocked non-wasm32 image addon: ' + specifier);
                    }
                    return nextResolve(specifier, context);
                },
            });

            const origResolve = Module._resolveFilename;
            Module._resolveFilename = function (request, parent, isMain, options) {
                if (typeof request === 'string') {
                    if (isBlockedNativeImg(request)) {
                        const err = new Error('Cannot find blocked native addon ' + request);
                        err.code = 'MODULE_NOT_FOUND';
                        throw err;
                    }
                    if (request.startsWith('@img/')) loadedImgModules.push(request);
                    if (request.startsWith('@/')) {
                        const base = path.join(repoRoot, 'src', request.slice(2));
                        for (const candidate of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
                            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                                return candidate;
                            }
                        }
                    }
                }
                return origResolve.call(this, request, parent, isMain, options);
            };

            require.extensions['.ts'] = function (mod, filename) {
                const raw = fs.readFileSync(filename, 'utf8');
                const compiled = ts.transpileModule(raw, {
                    compilerOptions: {
                        module: ts.ModuleKind.CommonJS,
                        target: ts.ScriptTarget.ES2022,
                        esModuleInterop: true,
                    },
                    fileName: filename,
                });
                return mod._compile(compiled.outputText, filename);
            };

            (async () => {
                const sharp = require('sharp');
                assert.equal(
                    loadedImgModules.some((m) => m.includes('sharp-wasm32')),
                    true,
                    'expected @img/sharp-wasm32 to load: ' + JSON.stringify(loadedImgModules),
                );
                assert.equal(
                    loadedImgModules.some((m) => isBlockedNativeImg(m)),
                    false,
                    'native sharp addon should never load',
                );

                // 构造 600x800 黑底白纸试卷图（四周深黑边，中间白纸区域）
                const whiteSheet = await sharp({
                    create: { width: 420, height: 560, channels: 3, background: { r: 248, g: 248, b: 248 } },
                }).png().toBuffer();

                const pageBuf = await sharp({
                    create: { width: 600, height: 800, channels: 3, background: { r: 10, g: 10, b: 10 } },
                })
                    .composite([{ input: whiteSheet, left: 90, top: 120 }])
                    .jpeg({ quality: 92 })
                    .toBuffer();

                const { normalizeImageBuffer } = require('@/lib/server/image-normalize');
                const { autoCropPaperImage } = require('@/lib/parent-paper-autocrop');
                const { cropDataUrlRegion } = require('@/lib/parent-paper-crop');

                const normalized = await normalizeImageBuffer(pageBuf);
                assert.equal(normalized.width, 600);
                assert.equal(normalized.height, 800);

                const autoCropped = await autoCropPaperImage(normalized.dataUrl);
                assert.equal(autoCropped.cropped, true);
                const autoMeta = await sharp(Buffer.from(autoCropped.imageUrl.split(',')[1], 'base64')).metadata();
                assert.ok(autoMeta.width < 580 && autoMeta.height < 780);

                const regionCropped = await cropDataUrlRegion(normalized.dataUrl, {
                    x: 0.2,
                    y: 0.25,
                    width: 0.4,
                    height: 0.3,
                });
                assert.equal(regionCropped.cropped, true);
                const regionMeta = await sharp(Buffer.from(regionCropped.imageUrl.split(',')[1], 'base64')).metadata();
                assert.equal(regionMeta.width, 240);
                assert.equal(regionMeta.height, 240);

                console.log(JSON.stringify({
                    ok: true,
                    versions: sharp.versions,
                    autoCropSize: [autoMeta.width, autoMeta.height],
                    regionCropSize: [regionMeta.width, regionMeta.height],
                }));
            })().catch((err) => {
                console.error(err);
                process.exit(1);
            });
        `;

        const stdout = execFileSync(process.execPath, ['-e', probeScript], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
            ok: boolean;
            autoCropSize: [number, number];
            regionCropSize: [number, number];
        };
        expect(result.ok).toBe(true);
        expect(result.regionCropSize).toEqual([240, 240]);
    }, 20000);
});
