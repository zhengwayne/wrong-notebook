import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { getAppTimeZone } from './config';
import { DEFAULT_TIME_ZONE, formatDateTime } from './date-time';
import { getErrorMessage } from './error-message';
import { createLogger } from './logger';
import { prisma } from './prisma';

const logger = createLogger('daily-snapshot');

export const DEFAULT_SNAPSHOT_RETENTION = 7;
const FIRST_CHECK_DELAY_MS = 30 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SNAPSHOT_FILE_RE = /^daily-snapshot-\d{4}-\d{2}-\d{2}\.db$/;
const STATUS_FILE_NAME = 'snapshot-status.json';

export interface DailySnapshotStatus {
    enabled: boolean;
    retentionCount: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastDateKey: string | null;
    lastSnapshotName: string | null;
    snapshotCount: number;
    lastError: string | null;
}

type SnapshotDb = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

interface GlobalSnapshotState {
    __dailySnapshotTimer?: ReturnType<typeof setInterval>;
    __dailySnapshotInFlight?: Map<string, Promise<DailySnapshotStatus>>;
    __dailySnapshotCache?: Map<string, DailySnapshotStatus>;
}

const globalState = globalThis as typeof globalThis & GlobalSnapshotState;

function getInFlightMap(): Map<string, Promise<DailySnapshotStatus>> {
    if (!globalState.__dailySnapshotInFlight) {
        globalState.__dailySnapshotInFlight = new Map();
    }
    return globalState.__dailySnapshotInFlight;
}

function getCacheMap(): Map<string, DailySnapshotStatus> {
    if (!globalState.__dailySnapshotCache) {
        globalState.__dailySnapshotCache = new Map();
    }
    return globalState.__dailySnapshotCache;
}

export function isDailySnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.DAILY_SNAPSHOT_ENABLED?.trim().toLowerCase();
    return raw !== 'false' && raw !== '0';
}

export function getSnapshotRetention(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.DAILY_SNAPSHOT_RETENTION?.trim();
    if (!raw) return DEFAULT_SNAPSHOT_RETENTION;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SNAPSHOT_RETENTION;
}

/** 从 DATABASE_URL 与 WRONG_NOTEBOOK_HOME 解析 SQLite 库路径与备份目录 */
export function resolveDatabasePaths(env: NodeJS.ProcessEnv = process.env): { dbFile: string; backupsDir: string } | null {
    const rawUrl = env.DATABASE_URL?.trim();
    if (!rawUrl || !rawUrl.startsWith('file:')) {
        return null;
    }
    const withoutScheme = rawUrl.slice('file:'.length);
    const queryIndex = withoutScheme.indexOf('?');
    const rawFile = (queryIndex === -1 ? withoutScheme : withoutScheme.slice(0, queryIndex)).trim();
    if (!rawFile || rawFile === ':memory:') {
        return null;
    }
    const dbFile = path.isAbsolute(rawFile)
        ? path.normalize(rawFile)
        : path.resolve(process.cwd(), 'prisma', rawFile);
    const homeDir = env.WRONG_NOTEBOOK_HOME?.trim();
    const backupsDir = homeDir
        ? path.join(path.resolve(homeDir), 'backups')
        : path.join(path.dirname(dbFile), 'backups');
    return { dbFile, backupsDir };
}

function sanitizeSnapshotError(error: unknown): string {
    const raw = getErrorMessage(error) || '快照创建失败';
    const stripped = raw
        .replace(/(?:[A-Za-z]:)?(?:\/[^\s:'"]+|\\[^\s:'"]+)+\//g, '')
        .trim();
    const message = stripped || '快照创建失败';
    return message.length > 200 ? `${message.slice(0, 200)}...` : message;
}

function listSnapshotFiles(backupsDir: string): string[] {
    if (!fs.existsSync(backupsDir)) return [];
    try {
        return fs.readdirSync(backupsDir)
            .filter((name) => SNAPSHOT_FILE_RE.test(name))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

function readDiskStatus(backupsDir: string): Partial<DailySnapshotStatus> | null {
    const file = path.join(backupsDir, STATUS_FILE_NAME);
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DailySnapshotStatus>;
    } catch {
        return null;
    }
}

function writeDiskStatus(backupsDir: string, status: DailySnapshotStatus): void {
    const file = path.join(backupsDir, STATUS_FILE_NAME);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function chmodBestEffort(filePath: string, mode: number): void {
    if (process.platform === 'win32') return;
    try {
        fs.chmodSync(filePath, mode);
    } catch {
        // 忽略不支持 POSIX 权限的文件系统
    }
}

function safeDateKey(now: Date): string {
    try {
        return formatDateTime(now, 'yyyy-MM-dd', getAppTimeZone());
    } catch {
        return formatDateTime(now, 'yyyy-MM-dd', DEFAULT_TIME_ZONE);
    }
}

let tmpSeq = 0;

async function executeVacuumInto(db: SnapshotDb, targetPath: string): Promise<void> {
    const escaped = targetPath.replace(/'/g, "''");
    const sql = `VACUUM INTO '${escaped}'`;
    try {
        await db.$executeRawUnsafe(sql);
    } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes('Execute returned results')) {
            await db.$queryRawUnsafe(sql);
            return;
        }
        throw error;
    }
}

export function getDailySnapshotStatus(env: NodeJS.ProcessEnv = process.env): DailySnapshotStatus {
    const enabled = isDailySnapshotEnabled(env);
    const retentionCount = getSnapshotRetention(env);
    const paths = resolveDatabasePaths(env);
    if (!paths) {
        return {
            enabled,
            retentionCount,
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastDateKey: null,
            lastSnapshotName: null,
            snapshotCount: 0,
            lastError: null,
        };
    }

    const files = listSnapshotFiles(paths.backupsDir);
    const disk = readDiskStatus(paths.backupsDir);
    const cached = getCacheMap().get(paths.backupsDir);

    // 若磁盘只读导致 snapshot-status.json 未能写盘，则以更新的内存缓存为准
    const useCached = cached && (!disk?.lastAttemptAt || (cached.lastAttemptAt ?? '') >= disk.lastAttemptAt);
    const base = useCached ? cached : disk;

    return {
        enabled,
        retentionCount,
        lastAttemptAt: base?.lastAttemptAt ?? null,
        lastSuccessAt: base?.lastSuccessAt ?? null,
        lastDateKey: base?.lastDateKey ?? null,
        lastSnapshotName: base?.lastSnapshotName ?? (files[0] ?? null),
        snapshotCount: files.length,
        lastError: base?.lastError ?? null,
    };
}

export async function runDailySnapshot(options: {
    db?: SnapshotDb;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    force?: boolean;
} = {}): Promise<DailySnapshotStatus> {
    const env = options.env ?? process.env;
    const enabled = isDailySnapshotEnabled(env);
    const retentionCount = getSnapshotRetention(env);
    const paths = resolveDatabasePaths(env);

    if (!paths || (!enabled && !options.force)) {
        return getDailySnapshotStatus(env);
    }

    const inFlightMap = getInFlightMap();
    const existingFlight = inFlightMap.get(paths.backupsDir);
    if (existingFlight) {
        return existingFlight;
    }

    const task = (async (): Promise<DailySnapshotStatus> => {
        const now = options.now ?? new Date();
        const db = options.db ?? prisma;
        const dateKey = safeDateKey(now);
        const targetName = `daily-snapshot-${dateKey}.db`;
        const targetPath = path.join(paths.backupsDir, targetName);
        const prev = getDailySnapshotStatus(env);

        if (!options.force && fs.existsSync(targetPath)) {
            try {
                if (fs.statSync(targetPath).size > 0 && prev.lastError === null) {
                    return prev;
                }
            } catch {
                // 继续重新生成
            }
        }

        const tmpPath = path.join(paths.backupsDir, `.daily-snapshot-${dateKey}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp.db`);
        try {
            fs.mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
            if (fs.existsSync(tmpPath)) {
                fs.rmSync(tmpPath, { force: true });
            }

            await executeVacuumInto(db, tmpPath);
            chmodBestEffort(tmpPath, 0o600);
            fs.renameSync(tmpPath, targetPath);

            const files = listSnapshotFiles(paths.backupsDir);
            for (const stale of files.slice(retentionCount)) {
                fs.rmSync(path.join(paths.backupsDir, stale), { force: true });
            }
            const kept = listSnapshotFiles(paths.backupsDir);

            const nextStatus: DailySnapshotStatus = {
                enabled,
                retentionCount,
                lastAttemptAt: now.toISOString(),
                lastSuccessAt: now.toISOString(),
                lastDateKey: dateKey,
                lastSnapshotName: targetName,
                snapshotCount: kept.length,
                lastError: null,
            };
            getCacheMap().set(paths.backupsDir, nextStatus);
            try {
                writeDiskStatus(paths.backupsDir, nextStatus);
            } catch (writeErr) {
                logger.warn({ error: writeErr }, 'Failed to persist snapshot status file');
            }
            logger.info({ snapshot: targetName, kept: kept.length }, 'Daily database snapshot created');
            return nextStatus;
        } catch (error) {
            try {
                fs.rmSync(tmpPath, { force: true });
            } catch {
                // 忽略临时文件清理异常
            }
            const errorMsg = sanitizeSnapshotError(error);
            const failedStatus: DailySnapshotStatus = {
                enabled,
                retentionCount,
                lastAttemptAt: now.toISOString(),
                lastSuccessAt: prev.lastSuccessAt,
                lastDateKey: prev.lastDateKey,
                lastSnapshotName: prev.lastSnapshotName,
                snapshotCount: listSnapshotFiles(paths.backupsDir).length,
                lastError: errorMsg,
            };
            getCacheMap().set(paths.backupsDir, failedStatus);
            try {
                writeDiskStatus(paths.backupsDir, failedStatus);
            } catch {
                // 目标目录可能只读，错误状态保留在内存缓存供接口展示
            }
            logger.error({ error: errorMsg }, 'Failed to create daily database snapshot');
            return failedStatus;
        }
    })();

    inFlightMap.set(paths.backupsDir, task);
    try {
        return await task;
    } finally {
        inFlightMap.delete(paths.backupsDir);
    }
}

/** 注册每日快照定时调度器：启动 30 秒后首次检查，之后每小时检查一次 */
export function startDailySnapshotScheduler(): void {
    if (globalState.__dailySnapshotTimer || !isDailySnapshotEnabled()) {
        return;
    }
    const tick = () => {
        runDailySnapshot().catch((error) => {
            logger.error({ error }, 'Daily snapshot scheduler tick failed');
        });
    };
    setTimeout(tick, FIRST_CHECK_DELAY_MS).unref?.();
    globalState.__dailySnapshotTimer = setInterval(tick, CHECK_INTERVAL_MS);
    globalState.__dailySnapshotTimer.unref?.();
    logger.info('Daily database snapshot scheduler started');
}
