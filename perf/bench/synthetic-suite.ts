/**
 * OPT-17 万题规模合成性能基准套件（可独立复现，使用临时 SQLite 数据库并在结束后清理）：
 * 采集错题列表、单题详情、缓存命中学习路径、v3 流式备份导出/导入、教师批改确认、AI 并发排队的
 * p50/p95/p99、SQL 次数、RSS 增量以及高频 SQL 的 EXPLAIN QUERY PLAN。
 *
 * 用法：
 *   npx tsx perf/bench/synthetic-suite.ts --scale=standard
 *   npx tsx perf/bench/synthetic-suite.ts --scale=large --json
 */
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import type { BackupUserMeta } from "@/lib/backup/types";
import { ERROR_ITEM_LIST_SELECT } from "@/lib/error-list-select";

type ScaleName = "standard" | "large";

interface ScaleConfig {
    name: ScaleName;
    errorItemsTotal: number;
    distribution: [number, number, number];
    classCount: number;
    studentsTotal: number;
    parentPapers: number;
    questionsPerPaper: number;
    listRuns: number;
    detailRuns: number;
    pathRuns: number;
    exportRuns: number;
    importRuns: number;
    confirmSubmissions: number;
}

const SCALE_CONFIGS: Record<ScaleName, ScaleConfig> = {
    standard: {
        name: "standard",
        errorItemsTotal: 1000,
        distribution: [400, 350, 250],
        classCount: 1,
        studentsTotal: 30,
        parentPapers: 4,
        questionsPerPaper: 8,
        listRuns: 20,
        detailRuns: 20,
        pathRuns: 15,
        exportRuns: 5,
        importRuns: 2,
        confirmSubmissions: 5,
    },
    large: {
        name: "large",
        errorItemsTotal: 10000,
        distribution: [4000, 3500, 2500],
        classCount: 3,
        studentsTotal: 100,
        parentPapers: 10,
        questionsPerPaper: 10,
        listRuns: 20,
        detailRuns: 20,
        pathRuns: 15,
        exportRuns: 3,
        importRuns: 1,
        confirmSubmissions: 5,
    },
};

interface LatencySummary {
    runs: number;
    minMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    avgSqlCount: number;
    maxSqlCount: number;
    rssBeforeMb: number;
    rssPeakMb: number;
    rssDeltaMb: number;
}

interface QueryPlanRow {
    id: number;
    parent: number;
    notused: number;
    detail: string;
}

interface PlanReport {
    name: string;
    sql: string;
    details: string[];
    usesIndex: boolean;
    hasTempBTree: boolean;
}

interface BenchmarkReport {
    scale: ScaleName;
    config: ScaleConfig;
    seedDurationMs: number;
    benchmarks: {
        errorListPaged: LatencySummary;
        errorListByLearner: LatencySummary;
        errorDetailRead: LatencySummary;
        learningPathCached: LatencySummary;
        classPathsCached: LatencySummary;
        dueItemsRead: LatencySummary;
        backupV3ExportStream: LatencySummary & { archiveBytes: number };
        backupV3ImportRestore: LatencySummary;
        gradingConfirm: LatencySummary;
        aiConcurrencyQueueWait: {
            totalCalls: number;
            concurrencyLimit: number;
            queueRejectedCount: number;
            waitMs: { p50: number; p95: number; p99: number; max: number };
        };
    };
    queryPlans: PlanReport[];
    thresholds: {
        errorListP95MaxMs: number;
        errorDetailP95MaxMs: number;
        cachedLearningPathP95MaxMs: number;
        allWithinThreshold: boolean;
    };
}

function parseCliArgs(): { scale: ScaleName; jsonOnly: boolean } {
    let scale: ScaleName = "standard";
    let jsonOnly = false;
    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith("--scale=")) {
            const val = arg.slice("--scale=".length);
            if (val === "standard" || val === "large") {
                scale = val;
            } else {
                throw new Error(`Invalid --scale value: ${val}`);
            }
        } else if (arg === "--json") {
            jsonOnly = true;
        }
    }
    return { scale, jsonOnly };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Number(sorted[idx].toFixed(2));
}

function rssMb(): number {
    return Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2));
}

function buildSyntheticImageDataUrl(index: number): string {
    const pad = "A".repeat(2048);
    return `data:image/png;base64,SYNTHETIC_${index}_${pad}`;
}

async function consumeStreamToFile(
    stream: ReadableStream<Uint8Array>,
    filePath: string,
    onChunk: () => void,
): Promise<number> {
    const reader = stream.getReader();
    const fd = openSync(filePath, "w");
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            writeSync(fd, value);
            totalBytes += value.byteLength;
            onChunk();
        }
    } finally {
        closeSync(fd);
    }
    return totalBytes;
}

async function measureScenario(
    runs: number,
    getSqlCount: () => number,
    fn: (runIdx: number) => Promise<void>,
): Promise<LatencySummary> {
    const durations: number[] = [];
    const sqlCounts: number[] = [];
    const rssBeforeMb = rssMb();
    let rssPeakMb = rssBeforeMb;

    for (let i = 0; i < runs; i += 1) {
        const sqlStart = getSqlCount();
        const t0 = performance.now();
        await fn(i);
        const elapsed = performance.now() - t0;
        durations.push(elapsed);
        sqlCounts.push(getSqlCount() - sqlStart);
        rssPeakMb = Math.max(rssPeakMb, rssMb());
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const totalSql = sqlCounts.reduce((acc, v) => acc + v, 0);
    return {
        runs,
        minMs: Number((sorted[0] ?? 0).toFixed(2)),
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
        avgSqlCount: Number((sqlCounts.length > 0 ? totalSql / sqlCounts.length : 0).toFixed(2)),
        maxSqlCount: sqlCounts.length > 0 ? Math.max(...sqlCounts) : 0,
        rssBeforeMb,
        rssPeakMb: Number(rssPeakMb.toFixed(2)),
        rssDeltaMb: Number(Math.max(0, rssPeakMb - rssBeforeMb).toFixed(2)),
    };
}

async function explainQueryPlan(
    db: PrismaClient,
    name: string,
    sql: string,
    params: unknown[],
): Promise<PlanReport> {
    const rows = await db.$queryRawUnsafe<QueryPlanRow[]>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
    const details = rows.map((row) => String(row.detail));
    const usesIndex = details.some((d) => d.includes("USING INDEX") || d.includes("USING COVERING INDEX"));
    const hasTempBTree = details.some((d) => d.includes("USE TEMP B-TREE"));
    return { name, sql, details, usesIndex, hasTempBTree };
}

async function runSuite(): Promise<void> {
    const { scale, jsonOnly } = parseCliArgs();
    const cfg = SCALE_CONFIGS[scale];

    const workDir = mkdtempSync(join(tmpdir(), `wn-bench-${scale}-`));
    const configDir = join(workDir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(configDir, "app-config.json"),
        JSON.stringify({ aiProvider: "openai", aiConcurrencyLimit: 3, aiDailyLimit: 0 }),
        "utf8",
    );

    const dbPath = join(workDir, "bench.db");
    const restoreDbPath = join(workDir, "restore.db");
    const dbUrl = `file:${dbPath}?connection_limit=1`;
    const restoreDbUrl = `file:${restoreDbPath}?connection_limit=1`;
    process.env.DATABASE_URL = dbUrl;
    process.env.CONFIG_DIR = configDir;

    let db: PrismaClient | null = null;
    let restoreDb: PrismaClient | null = null;
    try {
        execFileSync("npx", ["prisma", "migrate", "deploy"], {
            cwd: resolve(__dirname, "../.."),
            env: { ...process.env, DATABASE_URL: dbUrl },
            stdio: "pipe",
        });
        execFileSync("npx", ["prisma", "migrate", "deploy"], {
            cwd: resolve(__dirname, "../.."),
            env: { ...process.env, DATABASE_URL: restoreDbUrl },
            stdio: "pipe",
        });

        const { PrismaClient: ClientCtor } = await import("@prisma/client");
        const rawClient = new ClientCtor({
            datasources: { db: { url: dbUrl } },
            log: [{ emit: "event", level: "query" }],
        });

        let sqlCount = 0;
        rawClient.$on("query", () => {
            sqlCount += 1;
        });

        await rawClient.$connect();
        db = rawClient;

        // 必须在首次导入 @/lib/prisma 前绑定 globalThis.prisma，确保所有业务模块共享同一个带 query 监听的客户端
        const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
        globalForPrisma.prisma = rawClient;
        const { attachSqlitePragmas } = await import("@/lib/prisma");
        attachSqlitePragmas(rawClient, dbUrl, process.env);

        const rawRestoreClient = new ClientCtor({
            datasources: { db: { url: restoreDbUrl } },
            log: [{ emit: "event", level: "query" }],
        });
        attachSqlitePragmas(rawRestoreClient, restoreDbUrl, process.env);
        let restoreSqlCount = 0;
        rawRestoreClient.$on("query", () => {
            restoreSqlCount += 1;
        });
        await rawRestoreClient.$connect();
        restoreDb = rawRestoreClient;

        const { getOrReplanPath, listClassPaths } = await import("@/lib/learning-path/service");
        const { getDueItems } = await import("@/lib/due-items");
        const { confirmSubmission } = await import("@/lib/grading-service");
        const { createBackupV3Stream } = await import("@/lib/backup/export-v3");
        const { importBackupV3 } = await import("@/lib/backup/import-v3");
        const {
            getAiConcurrencyTelemetry,
            resetConcurrencyTelemetryForTest,
            runWithModelConcurrency,
        } = await import("@/lib/ai/concurrency");

        // ===== 1. 造数（计时不计入基准结果） =====
        const seedStart = performance.now();
        const passwordHash = await hash("bench-password-123", 4);

        const parentUser = await db.user.create({
            data: {
                id: "bench-parent",
                email: "parent-bench@example.com",
                password: passwordHash,
                name: "Bench Parent",
                role: "user",
                isActive: true,
                personas: JSON.stringify(["parent", "teacher"]),
                activePersona: "parent",
                personasConfirmedAt: new Date(),
            },
        });
        await restoreDb.user.create({
            data: {
                id: "bench-restore-target",
                email: "parent-bench@example.com",
                password: passwordHash,
                name: "Bench Parent",
                role: "user",
                isActive: true,
            },
        });

        const subjects = await Promise.all(
            ["数学", "物理", "英语"].map((name, idx) =>
                db!.subject.create({
                    data: { id: `subj-${idx + 1}`, userId: parentUser.id, name },
                }),
            ),
        );

        const tags = await Promise.all(
            ["一元二次方程", "勾股定理", "牛顿第二定律", "定语从句"].map((name, idx) =>
                db!.knowledgeTag.create({
                    data: {
                        id: `tag-${idx + 1}`,
                        name,
                        subject: idx === 2 ? "physics" : idx === 3 ? "english" : "math",
                        userId: parentUser.id,
                        isSystem: false,
                    },
                }),
            ),
        );

        const learners = await Promise.all(
            ["小一", "小二", "小三"].map((name, idx) =>
                db!.learner.create({
                    data: {
                        id: `child-${idx + 1}`,
                        userId: parentUser.id,
                        kind: "child",
                        name,
                        order: idx,
                    },
                }),
            ),
        );

        // 批量创建错题（分批 200 条避免 SQLite 变量上限）
        const createdItemIds: string[] = [];
        const baseCreatedAt = Date.now() - cfg.errorItemsTotal * 60_000;
        const BATCH_SIZE = 200;

        let globalIndex = 0;
        for (let childIdx = 0; childIdx < learners.length; childIdx += 1) {
            const count = cfg.distribution[childIdx];
            const learner = learners[childIdx];
            for (let start = 0; start < count; start += BATCH_SIZE) {
                const end = Math.min(count, start + BATCH_SIZE);
                const rows = [];
                for (let j = start; j < end; j += 1) {
                    const id = `ei-${globalIndex + 1}`;
                    createdItemIds.push(id);
                    const subj = subjects[globalIndex % subjects.length];
                    const kpName = tags[globalIndex % tags.length].name;
                    rows.push({
                        id,
                        shortId: `S${String(globalIndex + 1).padStart(5, "0")}`,
                        userId: parentUser.id,
                        subjectId: subj.id,
                        learnerId: learner.id,
                        originalImageUrl: buildSyntheticImageDataUrl(globalIndex),
                        questionText: `第 ${globalIndex + 1} 题：已知实数 x 满足方程与${kpName}性质，求最值。`,
                        answerText: "x = 3",
                        analysis: "代入公式化简求解。",
                        wrongAnswerText: "x = 1",
                        mistakeStatus: globalIndex % 3 === 0 ? "wrong_attempt" : "not_attempted",
                        knowledgePoints: JSON.stringify([kpName]),
                        masteryLevel: globalIndex % 3,
                        masteryProbability: globalIndex % 3 === 2 ? 0.85 : 0.25,
                        createdAt: new Date(baseCreatedAt + globalIndex * 60_000),
                    });
                    globalIndex += 1;
                }
                await db.errorItem.createMany({ data: rows });
            }
        }

        // 为前 600 条或全部代表题建立 tag 关联与 ItemMemory
        const tagLinkTarget = Math.min(createdItemIds.length, 600);
        for (let i = 0; i < tagLinkTarget; i += 100) {
            const slice = createdItemIds.slice(i, Math.min(tagLinkTarget, i + 100));
            const tag = tags[(i / 100) % tags.length];
            await db.knowledgeTag.update({
                where: { id: tag.id },
                data: { errorItems: { connect: slice.map((id) => ({ id })) } },
            });
        }
        await db.itemMemory.createMany({
            data: createdItemIds.slice(0, Math.min(createdItemIds.length, 200)).map((errorItemId, idx) => ({
                userId: parentUser.id,
                learnerId: learners[0].id,
                scopeKey: learners[0].id,
                errorItemId,
                stability: 2.5,
                difficulty: 5.0,
                dueAt: new Date(Date.now() - (idx % 10) * 3600_000),
                reps: 1,
                lapses: 0,
            })),
        });

        // 家长试卷（多页多题）
        for (let p = 0; p < cfg.parentPapers; p += 1) {
            const learner = learners[p % learners.length];
            const paper = await db.parentPaper.create({
                data: {
                    userId: parentUser.id,
                    learnerId: learner.id,
                    title: `测试试卷 ${p + 1}`,
                    status: "confirmed",
                },
            });
            await db.parentPaperPage.createMany({
                data: [0, 1].map((pos) => ({
                    paperId: paper.id,
                    position: pos,
                    imageUrl: buildSyntheticImageDataUrl(pos),
                })),
            });
            await db.parentPaperQuestion.createMany({
                data: Array.from({ length: cfg.questionsPerPaper }, (_, qIdx) => ({
                    paperId: paper.id,
                    position: qIdx + 1,
                    number: String(qIdx + 1),
                    questionText: `试卷 ${p + 1} 第 ${qIdx + 1} 题`,
                    verdict: qIdx % 2 === 0 ? "wrong" : "correct",
                    knowledgePoints: JSON.stringify([tags[qIdx % tags.length].name]),
                })),
            });
        }

        // 教师班级 + 学生花名册 + 学习路径证据 + 待确认批改答卷
        const classes: Array<{ id: string; name: string }> = [];
        const allStudents: Array<{ id: string; classId: string }> = [];
        for (let c = 0; c < cfg.classCount; c += 1) {
            const cls = await db.gradingClass.create({
                data: { userId: parentUser.id, name: `高一(${c + 1})班` },
            });
            classes.push(cls);
        }
        for (let s = 0; s < cfg.studentsTotal; s += 1) {
            const cls = classes[s % classes.length];
            const stu = await db.gradingStudent.create({
                data: {
                    classId: cls.id,
                    name: `学生${s + 1}`,
                    studentNo: String(1000 + s),
                    order: s,
                },
            });
            await db.learner.create({
                data: {
                    userId: parentUser.id,
                    kind: "student",
                    name: stu.name,
                    gradingStudentId: stu.id,
                    order: s,
                },
            });
            allStudents.push({ id: stu.id, classId: cls.id });
        }

        // 创建一次批改任务及已判分历史（用于 listClassPaths）+ 待确认答卷（用于 confirmSubmission）
        const gradingTask = await db.gradingTask.create({
            data: {
                userId: parentUser.id,
                classId: classes[0].id,
                title: "月考测试",
                subjectName: "数学",
            },
        });
        const keyQuestions = await Promise.all(
            Array.from({ length: 5 }, (_, qIdx) =>
                db!.gradingKeyQuestion.create({
                    data: {
                        taskId: gradingTask.id,
                        order: qIdx + 1,
                        number: String(qIdx + 1),
                        answer: String(qIdx + 10),
                        questionText: `标准题干 ${qIdx + 1}`,
                        knowledgePoints: JSON.stringify([tags[qIdx % tags.length].name]),
                    },
                }),
            ),
        );

        const pendingConfirmSubIds: string[] = [];
        for (let s = 0; s < allStudents.length; s += 1) {
            const sub = await db.gradingSubmission.create({
                data: {
                    taskId: gradingTask.id,
                    studentId: allStudents[s].id,
                    status: s < cfg.confirmSubmissions ? "graded" : "confirmed",
                    images: JSON.stringify([buildSyntheticImageDataUrl(s % 10)]),
                },
            });
            if (s < cfg.confirmSubmissions) {
                pendingConfirmSubIds.push(sub.id);
            }
            await db.gradingResult.createMany({
                data: keyQuestions.map((kq, qIdx) => ({
                    submissionId: sub.id,
                    keyQuestionId: kq.id,
                    verdict: qIdx % 2 === 0 ? "wrong" : "correct",
                    score: qIdx % 2 === 0 ? 0 : 1,
                    source: "ai",
                })),
            });
        }

        // 预热学习路径缓存（使后续测量全部命中缓存，不含首次重算）
        await getOrReplanPath(parentUser.id, { studentKey: learners[0].id, language: "zh", force: true });
        await listClassPaths(parentUser.id, classes[0].id, "zh");

        const seedDurationMs = Number((performance.now() - seedStart).toFixed(2));

        // ===== 2. 执行各项基准测试 =====
        const sampleItemId = createdItemIds[Math.floor(createdItemIds.length / 2)];
        const childOne = learners[0];

        const errorListPaged = await measureScenario(cfg.listRuns, () => sqlCount, async (runIdx) => {
            const skip = (runIdx % 10) * 12;
            const where = { userId: parentUser.id };
            await Promise.all([
                db!.errorItem.count({ where }),
                db!.errorItem.findMany({
                    where,
                    select: ERROR_ITEM_LIST_SELECT,
                    orderBy: { createdAt: "desc" },
                    skip,
                    take: 12,
                }),
            ]);
        });

        const errorListByLearner = await measureScenario(cfg.listRuns, () => sqlCount, async (runIdx) => {
            const skip = (runIdx % 5) * 12;
            const where = {
                userId: parentUser.id,
                learnerId: childOne.id,
                subjectId: subjects[0].id,
            };
            await Promise.all([
                db!.errorItem.count({ where }),
                db!.errorItem.findMany({
                    where,
                    select: ERROR_ITEM_LIST_SELECT,
                    orderBy: { createdAt: "desc" },
                    skip,
                    take: 12,
                }),
            ]);
        });

        const errorDetailRead = await measureScenario(cfg.detailRuns, () => sqlCount, async () => {
            await db!.errorItem.findUnique({
                where: { id: sampleItemId },
                include: { subject: true, tags: true },
            });
        });

        const learningPathCached = await measureScenario(cfg.pathRuns, () => sqlCount, async () => {
            const res = await getOrReplanPath(parentUser.id, {
                studentKey: childOne.id,
                language: "zh",
            });
            if (!res || res.replanned) {
                throw new Error("Expected cached learning path without replanning");
            }
        });

        const classPathsCached = await measureScenario(cfg.pathRuns, () => sqlCount, async () => {
            const res = await listClassPaths(parentUser.id, classes[0].id, "zh");
            if (!res) {
                throw new Error("Expected class paths result");
            }
        });

        const dueItemsRead = await measureScenario(cfg.pathRuns, () => sqlCount, async () => {
            await getDueItems(db!, { userId: parentUser.id, learnerId: childOne.id }, {
                timeZone: "Asia/Shanghai",
                date: new Date(),
            });
        });

        const exportUserMeta: BackupUserMeta = {
            id: parentUser.id,
            email: parentUser.email,
            name: parentUser.name,
            educationStage: parentUser.educationStage,
            enrollmentYear: parentUser.enrollmentYear,
            gradeRecognitionMode: parentUser.gradeRecognitionMode,
            fixedGradeSemester: parentUser.fixedGradeSemester,
            role: parentUser.role,
            confirmBeforeImport: parentUser.confirmBeforeImport,
            questionDuplicateThreshold: parentUser.questionDuplicateThreshold,
            masteryThreshold: parentUser.masteryThreshold,
            enableGeogebra: parentUser.enableGeogebra,
            enableSvgAnimation: parentUser.enableSvgAnimation,
            variantPipelineEnabled: parentUser.variantPipelineEnabled,
            themePreference: parentUser.themePreference,
            reviewAlgorithmVersion: parentUser.reviewAlgorithmVersion,
        };

        const exportArchivePath = join(workDir, "backup-export.wnb");
        let lastArchiveBytesCount = 0;
        let exportPeakMb = rssMb();
        const exportRssBefore = rssMb();
        const exportStats = await measureScenario(cfg.exportRuns, () => sqlCount, async () => {
            const stream = createBackupV3Stream({
                db: db!,
                currentUser: exportUserMeta,
                exportAll: false,
            });
            lastArchiveBytesCount = await consumeStreamToFile(stream, exportArchivePath, () => {
                exportPeakMb = Math.max(exportPeakMb, rssMb());
            });
        });
        const backupV3ExportStream = {
            ...exportStats,
            rssBeforeMb: exportRssBefore,
            rssPeakMb: Number(exportPeakMb.toFixed(2)),
            rssDeltaMb: Number(Math.max(0, exportPeakMb - exportRssBefore).toFixed(2)),
            archiveBytes: lastArchiveBytesCount,
        };

        const archiveBuffer = readFileSync(exportArchivePath);
        const backupV3ImportRestore = await measureScenario(cfg.importRuns, () => restoreSqlCount, async (runIdx) => {
            if (runIdx > 0) {
                await restoreDb!.user.deleteMany({ where: { email: parentUser.email } });
                await restoreDb!.user.create({
                    data: {
                        id: `bench-restore-target-${runIdx}`,
                        email: parentUser.email,
                        password: passwordHash,
                        name: "Bench Parent",
                        role: "user",
                        isActive: true,
                    },
                });
            }
            const activeTarget = await restoreDb!.user.findUniqueOrThrow({
                where: { email: parentUser.email },
                select: { id: true, email: true },
            });
            await importBackupV3({
                db: restoreDb!,
                source: archiveBuffer,
                currentUser: activeTarget,
                importAll: false,
            });
        });

        const gradingConfirm = await measureScenario(pendingConfirmSubIds.length, () => sqlCount, async (runIdx) => {
            await confirmSubmission(pendingConfirmSubIds[runIdx], parentUser.id);
        });

        // AI 并发排队等待基准（限 3 并发下提交 18 个短异步模拟任务）
        resetConcurrencyTelemetryForTest();
        await Promise.all(
            Array.from({ length: 18 }, (_, idx) =>
                runWithModelConcurrency("bench|local|mock", async () => {
                    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8 + (idx % 4) * 2));
                    return idx;
                }),
            ),
        );
        const aiSnap = getAiConcurrencyTelemetry();

        // ===== 3. EXPLAIN QUERY PLAN =====
        const queryPlans = await Promise.all([
            explainQueryPlan(
                db,
                "list_by_user_createdAt",
                `SELECT id FROM "ErrorItem" WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 12 OFFSET 0`,
                [parentUser.id],
            ),
            explainQueryPlan(
                db,
                "list_by_user_learner_createdAt",
                `SELECT id FROM "ErrorItem" WHERE "userId" = ? AND "learnerId" = ? ORDER BY "createdAt" DESC LIMIT 12 OFFSET 0`,
                [parentUser.id, childOne.id],
            ),
            explainQueryPlan(
                db,
                "list_by_user_subject_createdAt",
                `SELECT id FROM "ErrorItem" WHERE "userId" = ? AND "subjectId" = ? ORDER BY "createdAt" DESC LIMIT 12 OFFSET 0`,
                [parentUser.id, subjects[0].id],
            ),
            explainQueryPlan(
                db,
                "learning_path_lookup",
                `SELECT id FROM "LearningPath" WHERE "userId" = ? AND "studentKey" = ?`,
                [parentUser.id, childOne.id],
            ),
            explainQueryPlan(
                db,
                "item_memory_due",
                `SELECT id FROM "ItemMemory" WHERE "userId" = ? AND "scopeKey" = ? AND "dueAt" <= ? ORDER BY "dueAt" ASC LIMIT 20`,
                [parentUser.id, childOne.id, new Date().toISOString()],
            ),
            explainQueryPlan(
                db,
                "provenance_paper_group",
                `SELECT "provenanceId", COUNT(*) FROM "ParentPaperQuestion" WHERE "provenanceId" IS NOT NULL GROUP BY "provenanceId"`,
                [],
            ),
        ]);

        const thresholds = {
            errorListP95MaxMs: 500,
            errorDetailP95MaxMs: 500,
            cachedLearningPathP95MaxMs: 1000,
            allWithinThreshold:
                errorListPaged.p95Ms <= 500
                && errorListByLearner.p95Ms <= 500
                && errorDetailRead.p95Ms <= 500
                && learningPathCached.p95Ms <= 1000
                && classPathsCached.p95Ms <= 1000,
        };

        const report: BenchmarkReport = {
            scale,
            config: cfg,
            seedDurationMs,
            benchmarks: {
                errorListPaged,
                errorListByLearner,
                errorDetailRead,
                learningPathCached,
                classPathsCached,
                dueItemsRead,
                backupV3ExportStream,
                backupV3ImportRestore,
                gradingConfirm,
                aiConcurrencyQueueWait: {
                    totalCalls: aiSnap.totalCalls,
                    concurrencyLimit: aiSnap.limit,
                    queueRejectedCount: aiSnap.queueRejectedCount,
                    waitMs: aiSnap.waitMs,
                },
            },
            queryPlans,
            thresholds,
        };

        if (jsonOnly) {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
            process.stdout.write(`=== OPT-17 Synthetic Benchmark (${scale}, ${cfg.errorItemsTotal} items, seed ${seedDurationMs}ms) ===\n`);
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }

        if (!thresholds.allWithinThreshold) {
            process.exitCode = 1;
        }
    } finally {
        await restoreDb?.$disconnect();
        await db?.$disconnect();
        rmSync(workDir, { recursive: true, force: true });
    }
}

void runSuite();
