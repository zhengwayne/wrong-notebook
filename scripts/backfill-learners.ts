/**
 * 手动执行或撤回学习者回填：
 *   npx tsx scripts/backfill-learners.ts
 *   npx tsx scripts/backfill-learners.ts --revert
 *   npx tsx scripts/backfill-learners.ts --revert --batch <batchId>
 *
 * 应用启动时也会幂等执行 apply（见 src/instrumentation.ts）。
 */
import { prisma } from '../src/lib/prisma';
import { applyLearnerBackfill, revertLearnerBackfill } from '../src/lib/learner-backfill';

async function main() {
    const args = process.argv.slice(2);
    const revert = args.includes('--revert');
    const batchIdx = args.indexOf('--batch');
    const batchId = batchIdx >= 0 ? args[batchIdx + 1] : undefined;
    if (revert) {
        const result = await revertLearnerBackfill(prisma, batchId);
        console.log(JSON.stringify({ action: 'revert', ...result }, null, 2));
    } else {
        const result = await applyLearnerBackfill(prisma);
        console.log(JSON.stringify({ action: 'apply', ...result }, null, 2));
    }
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
