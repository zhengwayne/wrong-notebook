#!/usr/bin/env node
/**
 * 同 SHA 全量 CI 发布门禁：
 * 在触发 Release、Packages 与 Docker 标签构建前，校验同一底层 commit SHA
 * 已存在至少一次已完成的 ci.yml 运行，且全部 7 个必需 Job 的结论均为 success（拒绝 skipped）。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_CI_JOBS = [
    'Public History Check',
    'Windows Signature Validation',
    'Unit Tests',
    'Integration Tests',
    'Test Coverage',
    'Build Check',
    'E2E Tests',
];

/**
 * 解析附注标签或任意 Git 引用到底层 commit SHA；若无本地仓库则原样返回。
 */
export function resolveCommitSha(refOrSha, runGit = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) {
    if (!refOrSha) return '';
    try {
        const resolved = runGit(['rev-parse', '--verify', `${refOrSha}^{commit}`]);
        return resolved || refOrSha;
    } catch {
        return refOrSha;
    }
}

/**
 * 从候选 ci.yml 运行记录中判定是否存在同一 SHA 下所有必需 Job 全绿的完成记录。
 */
export async function evaluateCiGate(runs, getJobsForRun, options = {}) {
    const { currentRunId, requiredJobs = REQUIRED_CI_JOBS } = options;
    const completedRuns = (runs || []).filter(
        (run) => run && run.status === 'completed' && String(run.id) !== String(currentRunId ?? ''),
    );

    if (completedRuns.length === 0) {
        return {
            ok: false,
            reason: '未找到同一 commit SHA 已完成的 ci.yml 运行记录（请先在 main 分支通过完整 CI 后再打标签）。',
        };
    }

    const failureDetails = [];
    for (const run of completedRuns) {
        const jobs = await getJobsForRun(run.id);
        const byName = new Map();
        for (const job of jobs || []) {
            if (job && typeof job.name === 'string') {
                byName.set(job.name, job);
            }
        }

        const unmet = [];
        for (const reqName of requiredJobs) {
            const job = byName.get(reqName);
            if (!job) {
                unmet.push(`${reqName}:missing`);
            } else if (job.conclusion !== 'success') {
                unmet.push(`${reqName}:${job.conclusion ?? 'null'}`);
            }
        }

        if (unmet.length === 0) {
            return {
                ok: true,
                matchedRunId: run.id,
                matchedHtmlUrl: run.html_url || null,
            };
        }
        failureDetails.push(`run#${run.id} [${unmet.join(', ')}]`);
    }

    return {
        ok: false,
        reason: `同一 commit SHA 尚未有全部必需 Job 通过（conclusion=success）的 ci.yml 记录：${failureDetails.join('; ')}`,
    };
}

async function fetchJson(url, token) {
    const res = await fetch(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'wrong-notebook-ci-gate',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API 请求失败 (${res.status}): ${url} ${body}`);
    }
    return res.json();
}

async function fetchWorkflowRunsForSha(apiBase, repo, sha, token) {
    const runs = [];
    for (let page = 1; page <= 5; page++) {
        const url = `${apiBase}/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100&page=${page}`;
        const data = await fetchJson(url, token);
        const batch = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
        runs.push(...batch);
        if (batch.length < 100 || runs.length >= (data.total_count || 0)) break;
    }
    return runs;
}

async function fetchJobsForRun(apiBase, repo, runId, token) {
    const jobs = [];
    for (let page = 1; page <= 5; page++) {
        const url = `${apiBase}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
        const data = await fetchJson(url, token);
        const batch = Array.isArray(data.jobs) ? data.jobs : [];
        jobs.push(...batch);
        if (batch.length < 100 || jobs.length >= (data.total_count || 0)) break;
    }
    return jobs;
}

async function main() {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const rawSha = process.env.TARGET_SHA || process.env.GITHUB_SHA;
    const currentRunId = process.env.GITHUB_RUN_ID;
    const apiBase = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

    if (!repo || !token || !rawSha) {
        console.error('[ci-gate] 缺少必要环境变量 GITHUB_REPOSITORY / GITHUB_TOKEN / TARGET_SHA');
        process.exit(1);
    }

    const commitSha = resolveCommitSha(rawSha);
    console.log(`[ci-gate] 检查 commit ${commitSha} 的 ci.yml 全量通过状态...`);

    const runs = await fetchWorkflowRunsForSha(apiBase, repo, commitSha, token);
    const result = await evaluateCiGate(
        runs,
        (runId) => fetchJobsForRun(apiBase, repo, runId, token),
        { currentRunId },
    );

    if (!result.ok) {
        console.error(`[ci-gate] 发布拦截：${result.reason}`);
        process.exit(1);
    }

    console.log(`[ci-gate] 校验通过：已匹配 ci.yml run #${result.matchedRunId}${result.matchedHtmlUrl ? ` (${result.matchedHtmlUrl})` : ''}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    main().catch((error) => {
        console.error(`[ci-gate] 检查异常：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
