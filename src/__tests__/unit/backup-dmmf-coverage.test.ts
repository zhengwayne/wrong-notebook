/**
 * OPT-21 基于 Prisma DMMF 的备份模型与核心字段覆盖护栏测试：
 * 新增模型或向 ErrorItem / PracticeRecord 添加标量列时，若未同步到 v3 导出导入与清单将直接失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
    BACKUP_EXCLUDED_MODELS,
    BACKUP_EXPORTED_MODELS,
    BACKUP_PENDING_V3_MODELS,
    ERROR_ITEM_IMPORT_FIELD_COVERAGE,
    PRACTICE_RECORD_IMPORT_FIELD_COVERAGE,
    type FieldCoverageSpec,
} from '@/lib/backup-model-registry';

const exportV3Source = fs.readFileSync(path.resolve('src/lib/backup/export-v3.ts'), 'utf8');
const importV3Source = fs.readFileSync(path.resolve('src/lib/backup/import-v3.ts'), 'utf8');

function scalarFieldsOf(modelName: string): string[] {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    if (!model) throw new Error(`Prisma DMMF 中未找到模型 ${modelName}`);
    return model.fields.filter((f) => f.kind === 'scalar').map((f) => f.name);
}

function assertFieldCoverage(modelName: string, spec: FieldCoverageSpec) {
    const actualFields = new Set(scalarFieldsOf(modelName));
    const mappedSet = new Set(spec.mapped);
    const deferredSet = new Set(Object.keys(spec.deferredOrGenerated));

    const overlap = [...mappedSet].filter((f) => deferredSet.has(f));
    expect(overlap, `${modelName} 清单中存在重叠字段`).toEqual([]);

    const registered = new Set([...mappedSet, ...deferredSet]);
    const unregistered = [...actualFields].filter((f) => !registered.has(f));
    expect(unregistered, `${modelName} 新增了未在备份清单登记的标量字段`).toEqual([]);

    const obsolete = [...registered].filter((f) => !actualFields.has(f));
    expect(obsolete, `${modelName} 清单包含已不存在的标量字段`).toEqual([]);

    for (const field of spec.mapped) {
        expect(
            importV3Source.includes(`${field}:`) || importV3Source.includes(`${field},`),
            `src/lib/backup/import-v3.ts 缺少 ${modelName}.${field} 的导入写入`,
        ).toBe(true);
    }
}

describe('Prisma DMMF 数据备份覆盖护栏', () => {
    it('全部 Prisma 模型均已完成导出或明确排除（待迁移清单为空）', () => {
        const exported = Object.keys(BACKUP_EXPORTED_MODELS);
        const excluded = Object.keys(BACKUP_EXCLUDED_MODELS);
        const pendingV3 = Object.keys(BACKUP_PENDING_V3_MODELS);

        expect(pendingV3).toEqual([]);
        expect(new Set(exported).size + new Set(excluded).size).toBe(
            new Set([...exported, ...excluded]).size,
        );

        const dmmfModels = Prisma.dmmf.datamodel.models.map((m) => m.name).sort();
        const registeredModels = [...exported, ...excluded].sort();
        expect(registeredModels).toEqual(dmmfModels);

        for (const [model, marker] of Object.entries(BACKUP_EXPORTED_MODELS)) {
            expect(
                exportV3Source.includes(marker),
                `src/lib/backup/export-v3.ts 未导出模型 ${model}（标记 ${marker}）`,
            ).toBe(true);
        }
    });

    it('ErrorItem 全部标量字段均已覆盖或显式登记', () => {
        assertFieldCoverage('ErrorItem', ERROR_ITEM_IMPORT_FIELD_COVERAGE);
    });

    it('PracticeRecord 全部标量字段均已覆盖或显式登记', () => {
        assertFieldCoverage('PracticeRecord', PRACTICE_RECORD_IMPORT_FIELD_COVERAGE);
    });
});
