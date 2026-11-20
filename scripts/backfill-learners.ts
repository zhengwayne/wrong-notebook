/**
 * 教师端历史学习者归属治理（D2 四步 CLI）：
 *   1. 只读盘点：npx tsx scripts/backfill-learners.ts --inventory
 *   2. 导出歧义：npx tsx scripts/backfill-learners.ts --export-ambiguous ambiguous.json
 *   3. 自动回填：npx tsx scripts/backfill-learners.ts
 *   4. 人工确认：npx tsx scripts/backfill-learners.ts --apply-decisions decisions.json
 *   5. 精确撤回：npx tsx scripts/backfill-learners.ts --revert [--batch <batchId>]
 */
import fs from 'node:fs';
import { prisma } from '../src/lib/prisma';
import {
    applyLearnerBackfill,
    applyManualLearnerDecisions,
    exportAmbiguousLearnerItems,
    inventoryLearnerBackfill,
    revertLearnerBackfill,
    type ManualLearnerDecision,
} from '../src/lib/learner-backfill';

function getArgValue(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--inventory') || args.includes('--dry-run')) {
        const report = await inventoryLearnerBackfill(prisma);
        console.log(JSON.stringify({ action: 'inventory', ...report }, null, 2));
        return;
    }

    const exportFile = getArgValue(args, '--export-ambiguous');
    if (exportFile) {
        const exported = await exportAmbiguousLearnerItems(prisma);
        fs.writeFileSync(exportFile, JSON.stringify(exported, null, 2), 'utf8');
        console.log(JSON.stringify({
            action: 'export-ambiguous',
            file: exportFile,
            ambiguousCount: exported.ambiguousItems.length,
            orphanedNotebookCount: exported.orphanedStudentNotebooks.length,
        }, null, 2));
        return;
    }

    const decisionsFile = getArgValue(args, '--apply-decisions');
    if (decisionsFile) {
        const raw = JSON.parse(fs.readFileSync(decisionsFile, 'utf8')) as
            | ManualLearnerDecision[]
            | { decisions: ManualLearnerDecision[] };
        const decisions = Array.isArray(raw) ? raw : raw.decisions;
        const result = await applyManualLearnerDecisions(prisma, decisions);
        console.log(JSON.stringify({ action: 'apply-decisions', ...result }, null, 2));
        return;
    }

    if (args.includes('--revert')) {
        const batchId = getArgValue(args, '--batch');
        const result = await revertLearnerBackfill(prisma, batchId);
        console.log(JSON.stringify({ action: 'revert', ...result }, null, 2));
        return;
    }

    const result = await applyLearnerBackfill(prisma);
    console.log(JSON.stringify({ action: 'apply', ...result }, null, 2));
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
