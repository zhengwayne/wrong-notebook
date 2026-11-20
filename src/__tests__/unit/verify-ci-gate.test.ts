/**
 * 同 SHA 全量 CI 发布门禁单元测试
 */
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_CI_JOBS, evaluateCiGate, resolveCommitSha } from '../../../scripts/verify-ci-gate.mjs';

function allGreenJobs() {
    return REQUIRED_CI_JOBS.map((name) => ({ name, conclusion: 'success' }));
}

describe('evaluateCiGate', () => {
    it('没有任何已完成运行记录时拒绝发布', async () => {
        const res = await evaluateCiGate(
            [{ id: 100, status: 'in_progress', html_url: 'https://example.com/100' }],
            vi.fn(),
            { currentRunId: '200' },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toContain('未找到');
    });

    it('排除当前自身 run 后无候选记录时拒绝发布', async () => {
        const res = await evaluateCiGate(
            [{ id: 200, status: 'completed', html_url: 'https://example.com/200' }],
            async () => allGreenJobs(),
            { currentRunId: '200' },
        );
        expect(res.ok).toBe(false);
    });

    it('仅有 tag 触发产出的 skipped 测试 Job 时严格拒绝发布', async () => {
        const tagRunJobs = REQUIRED_CI_JOBS.map((name) => ({
            name,
            conclusion: name === 'Public History Check' ? 'success' : 'skipped',
        }));

        const res = await evaluateCiGate(
            [{ id: 101, status: 'completed', html_url: 'https://example.com/101' }],
            async () => tagRunJobs,
            { currentRunId: '999' },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toContain('Unit Tests:skipped');
    });

    it('缺少必需 Job 或存在 failure/cancelled/neutral 时拒绝发布', async () => {
        const missingE2e = allGreenJobs().filter((job) => job.name !== 'E2E Tests');
        const failedUnit = allGreenJobs().map((job) =>
            job.name === 'Unit Tests' ? { ...job, conclusion: 'failure' } : job,
        );

        const res = await evaluateCiGate(
            [
                { id: 102, status: 'completed' },
                { id: 103, status: 'completed' },
            ],
            async (id: number) => (id === 102 ? missingE2e : failedUnit),
            { currentRunId: '999' },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toContain('E2E Tests:missing');
        expect(res.reason).toContain('Unit Tests:failure');
    });

    it('同时存在 tag skipped 运行与同一 SHA 的全绿 main 运行时正确通过', async () => {
        const skippedTagRunJobs = REQUIRED_CI_JOBS.map((name) => ({
            name,
            conclusion: name === 'Public History Check' ? 'success' : 'skipped',
        }));

        const res = await evaluateCiGate(
            [
                { id: 301, status: 'completed', html_url: 'https://example.com/301' },
                { id: 300, status: 'completed', html_url: 'https://example.com/300' },
            ],
            async (id: number) => (id === 301 ? skippedTagRunJobs : allGreenJobs()),
            { currentRunId: '999' },
        );
        expect(res).toEqual({
            ok: true,
            matchedRunId: 300,
            matchedHtmlUrl: 'https://example.com/300',
        });
    });
});

describe('resolveCommitSha', () => {
    it('将附注标签或引用解析为底层 commit SHA，失败时回退原值', () => {
        expect(resolveCommitSha('v2026.11.18-1', () => 'abc123def')).toBe('abc123def');
        expect(
            resolveCommitSha('deadbeef', () => {
                throw new Error('not a git repo');
            }),
        ).toBe('deadbeef');
    });
});
