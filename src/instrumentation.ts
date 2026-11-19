
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();

        // 构建阶段不启动定时任务
        if (process.env.NEXT_PHASE !== 'phase-production-build') {
            const { startCheckinScheduler } = await import('./lib/minimax-code/checkin');
            startCheckinScheduler();

            const { startDailySnapshotScheduler } = await import('./lib/daily-snapshot');
            startDailySnapshotScheduler();

            // 全新安装还没有管理员时，在启动日志中提示初始化令牌的文件位置
            const { announceSetupLink } = await import('./lib/initialization');
            await announceSetupLink();

            // 把历史「学生名·学科」错题挂到学习者；仅首次执行并写入幂等完成标记
            try {
                const { prisma } = await import('./lib/prisma');
                const { ensureLearnerBackfillOnce } = await import('./lib/learner-backfill');
                const { createLogger } = await import('./lib/logger');
                const result = await ensureLearnerBackfillOnce(prisma);
                if (result && (result.learnersCreated || result.errorItemsLinked || result.practiceRecordsLinked)) {
                    createLogger('learners').info({ result }, 'applied learner backfill');
                }

                // 进程中断后仍停在「识别中」的家长试卷标记为失败，并把遗留 running 异步作业标记为中断
                const { failStaleRecognizingPapers } = await import('./lib/parent-paper-recognize');
                const stale = await failStaleRecognizingPapers(prisma);
                if (stale) createLogger('parent-papers').info({ stale }, 'marked interrupted parent paper recognition as failed');

                const { recoverInterruptedAsyncOperations } = await import('./lib/async-operations');
                await recoverInterruptedAsyncOperations(prisma);
            } catch (error) {
                const { createLogger } = await import('./lib/logger');
                createLogger('learners').error({ error }, 'learner backfill failed');
            }
        }
    }
}
