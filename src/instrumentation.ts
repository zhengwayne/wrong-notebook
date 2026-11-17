
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();

        // 构建阶段不启动定时任务
        if (process.env.NEXT_PHASE !== 'phase-production-build') {
            const { startCheckinScheduler } = await import('./lib/minimax-code/checkin');
            startCheckinScheduler();

            // 全新安装还没有管理员时，在启动日志中打印一次性初始化链接
            const { announceSetupLink } = await import('./lib/initialization');
            await announceSetupLink();

            // 把历史「学生名·学科」错题挂到学习者；幂等，失败不阻止启动
            try {
                const { prisma } = await import('./lib/prisma');
                const { applyLearnerBackfill } = await import('./lib/learner-backfill');
                const { createLogger } = await import('./lib/logger');
                const result = await applyLearnerBackfill(prisma);
                if (result.learnersCreated || result.errorItemsLinked || result.practiceRecordsLinked) {
                    createLogger('learners').info({ result }, 'applied learner backfill');
                }
            } catch (error) {
                const { createLogger } = await import('./lib/logger');
                createLogger('learners').error({ error }, 'learner backfill failed');
            }
        }
    }
}
