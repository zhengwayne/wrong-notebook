# OPT-17 万题规模合成性能基准与 OPT-11b 评估报告

> 本文档记录 `perf/bench/synthetic-suite.ts` 在 `standard`（1,000 题）与 `large`（10,000 题）两档合成数据集上的实测耗时、SQL 查询计划、并发队列等待与进程内存指标，并给出复合索引与 OPT-11b（Asset 文件存储）的评估裁决。

## 1. 复现方式与测试环境

- **测试脚本**：[`perf/bench/synthetic-suite.ts`](./bench/synthetic-suite.ts)
- **复现命令**：
  ```bash
  npx tsx perf/bench/synthetic-suite.ts --scale=standard --json
  npx tsx perf/bench/synthetic-suite.ts --scale=large --json
  ```
- **数据隔离**：每次运行在系统临时目录中创建独立的 SQLite 数据库，执行 `prisma migrate deploy` 初始化表结构，合成测试数据完全在内存中构造并在进程退出时自动销毁。
- **运行时环境**：`darwin arm64`（10 核 Apple M1 Pro，16 GB 内存），Node.js `v22.19.0`。
- **数据规模设计**：
  - `standard`：1,000 道错题（3 个孩子按 400 / 350 / 250 分布，含唯一合成图片 data URL）、1 个班级 30 名学生、4 份多页家长试卷、5 份待确认批改答卷。
  - `large`：10,000 道错题（3 个孩子按 4000 / 3500 / 2500 分布，每道含独立图片 data URL）、3 个班级共 100 名学生、10 份多页家长试卷、5 份待确认批改答卷。

## 2. 基准测量前发现并修复的真实瓶颈（Prisma P2029）

在首次执行 `--scale=large` 时，单孩子拥有 4,000 道错题触发了 Prisma 客户端异常 **`P2029`**（`negation filters used prevent the query from being split`）。

- **根因**：`src/lib/learning-path/service.ts`、`src/lib/due-items.ts` 与 `src/lib/variant/service.ts` 中的无分页 `errorItem.findMany` 查询均在嵌套关联 `practiceRecords` 上使用了 `where: { result: { not: null } }` 否定过滤；当匹配错题数量超出 SQLite 批量查询拆批上限时，Prisma 因嵌套 `not` 条件拒绝拆分 `WHERE errorItemId IN (...)`，导致直接抛错；同时 `learning-path` 与 `variant` 查询未加字段投影，顺带加载了 `originalImageUrl` 与 SVG 动画大字段。
- **修复**：
  1. 移除上述 3 处嵌套关联上的 `result: { not: null }` 否定条件，改为返回后在应用层过滤 `record.result !== null`，恢复 Prisma 自动拆批能力；
  2. 为 `learning-path/service.ts`（`ITEM_WITH_EVIDENCE_SELECT`、`loadSourceItemsByIds`）与 `variant/service.ts`（`loadItemsByWhere`）补齐显式轻量 `select` 投影，剔除原图与动画等大字段；
  3. 在 `src/__tests__/integration/learning-path.test.ts` 中新增单学习者 2,600 道错题的真实 SQLite 回归测试，覆盖学习路径、到期复习与变式画像三条链路。

## 3. 合成性能实测数据（修复后）

### 3.1 `standard`（1,000 题 · 3 孩子 · 30 学生）

| 场景 | 样本数 | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | 平均 SQL 数 | 峰值 RSS 增量 (MB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `errorListPaged`（错题列表分页） | 20 | 0.66 | 0.83 | 1.71 | 1.71 | 3 | 0.13 |
| `errorListByLearner`（按孩子+学科分页） | 20 | 1.79 | 2.05 | 2.26 | 2.26 | 4 | 0.05 |
| `errorDetailRead`（单题详情含原图） | 20 | 0.46 | 0.60 | 0.87 | 0.87 | 4 | 0.02 |
| `learningPathCached`（单孩子缓存学习路径） | 15 | 32.86 | 34.04 | 34.04 | 34.04 | 11 | 6.50 |
| `classPathsCached`（30 人班级缓存路径总览） | 15 | 9.99 | 10.43 | 10.43 | 10.43 | 11 | 0.26 |
| `dueItemsRead`（今日到期复习计算） | 15 | 23.50 | 24.00 | 24.00 | 24.00 | 3 | 0.05 |
| `gradingConfirm`（教师批改确认入库） | 5 | 6.64 | 45.73 | 45.73 | 45.73 | 42 | 0.13 |
| `backupV3ExportStream`（v3 流式导出，70,539 B） | 5 | 965.14 | 1021.05 | 1021.05 | 1021.05 | 1376 | 55.86 |
| `backupV3ImportRestore`（v3 归档恢复） | 2 | 1516.17 | 1548.98 | 1548.98 | 1548.98 | 7514 | 16.70 |

- AI 并发队列等待耗时（`limit = 3`，18 并发短任务）：`p50 = 28 ms`，`p95 = 63 ms`，`max = 63 ms`，队列拒绝次数 `0`。

### 3.2 `large`（10,000 题 · 3 孩子 · 100 学生）

| 场景 | 样本数 | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | 平均 SQL 数 | 峰值 RSS 增量 (MB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `errorListPaged`（错题列表分页） | 20 | 1.13 | 1.36 | 1.73 | 1.73 | 3 | 0.06 |
| `errorListByLearner`（按孩子+学科分页） | 20 | 11.08 | 11.69 | 16.99 | 16.99 | 3 | 0.07 |
| `errorDetailRead`（单题详情含原图） | 20 | 0.35 | 0.58 | 0.83 | 0.83 | 3 | 0.02 |
| `learningPathCached`（单孩子 4,000 题缓存路径） | 15 | 291.37 | 307.66 | 307.66 | 307.66 | 15 | 132.75 |
| `classPathsCached`（100 人班级缓存路径总览） | 15 | 21.54 | 22.55 | 22.55 | 22.55 | 11 | 0.47 |
| `dueItemsRead`（今日到期复习计算） | 15 | 230.84 | 237.68 | 237.68 | 237.68 | 7 | 3.44 |
| `gradingConfirm`（教师批改确认入库） | 5 | 8.36 | 17.91 | 17.91 | 17.91 | 43.2 | 1.03 |
| `backupV3ExportStream`（v3 流式导出，462,248 B） | 3 | 54581.00 | 55535.91 | 55535.91 | 55535.91 | 10686.67 | 15.10 |
| `backupV3ImportRestore`（v3 归档恢复） | 1 | 13732.78 | 13732.78 | 13732.78 | 13732.78 | 63636 | 46.17 |

- AI 并发队列等待耗时（`limit = 3`，18 并发短任务）：`p50 = 43 ms`，`p95 = 64 ms`，`max = 64 ms`，队列拒绝次数 `0`。
- **验收阈值判定**：
  - 普通错题列表与详情 `p95` 要求 `<= 500 ms`：实测万题规模 `1.36–11.69 ms`（**达标**，裕度 > 42 倍）。
  - 缓存学习路径与班级路径 `p95` 要求 `<= 1000 ms`：实测万题规模 `22.55–307.66 ms`（**达标**，裕度 > 3.2 倍）。

## 4. `EXPLAIN QUERY PLAN` 与复合索引结论

在 10,000 题库上采集的核心 SQL 执行计划如下：

| 查询标识 | SQL 摘要 | SQLite 执行计划 | 走索引 / Temp B-Tree |
| --- | --- | --- | --- |
| `list_by_user_createdAt` | `ErrorItem WHERE userId = ? ORDER BY createdAt DESC LIMIT 12` | `SEARCH ErrorItem USING INDEX ErrorItem_userId_createdAt_idx (userId=?)` | 是 / 无 |
| `list_by_user_learner_createdAt` | `ErrorItem WHERE userId = ? AND learnerId = ? ORDER BY createdAt DESC LIMIT 12` | `SEARCH ErrorItem USING INDEX ErrorItem_userId_createdAt_idx (userId=?)` | 是 / 无 |
| `list_by_user_subject_createdAt` | `ErrorItem WHERE userId = ? AND subjectId = ? ORDER BY createdAt DESC LIMIT 12` | `SEARCH ErrorItem USING INDEX ErrorItem_userId_createdAt_idx (userId=?)` | 是 / 无 |
| `learning_path_lookup` | `LearningPath WHERE userId = ? AND studentKey = ?` | `SEARCH LearningPath USING INDEX LearningPath_userId_studentKey_key` | 是 / 无 |
| `item_memory_due` | `ItemMemory WHERE userId = ? AND scopeKey = ? AND dueAt <= ? ORDER BY dueAt ASC LIMIT 20` | `SEARCH ItemMemory USING INDEX ItemMemory_userId_scopeKey_dueAt_idx` | 是 / 无 |
| `provenance_paper_group` | `ParentPaperQuestion WHERE provenanceId IS NOT NULL GROUP BY provenanceId` | `SCAN ParentPaperQuestion` / `USE TEMP B-TREE FOR GROUP BY` | 低频管理员聚合 |

- **索引决策**：五个高频前台路径查询均已命中有序联合索引且无临时 B-Tree 排序开销，在 10,000 题规模下列表/按孩子筛选 `p95` 仅为 `1.36–11.69 ms`；仅管理员低频诊断接口 `GET /api/admin/metrics` 中的溯源质量分组存在全表扫描。依据 OPT-17 **“以实测查询计划为准、不预先添加冗余索引”** 原则，本阶段**不额外增加复合索引迁移**，避免拖慢高频批量写入（导入与试卷入库）。

## 5. OPT-11b（Asset 文件存储）评估裁决

依据 OPT-17 实测数据进行评估：

1. **前台读取延迟已与图片体积解耦**：`ERROR_ITEM_LIST_SELECT` 与本次修复后的 `learning-path` / `variant` 显式字段投影已完全跳过 `originalImageUrl` 等大文本列，10,000 题下列表与详情 `p95` 均低于 `12 ms`。
2. **流式备份导出/恢复内存峰值高度可控**：v3 归档导出通过 `MEDIA_PAGE_SIZE = 2` 游标分片与流式 ZIP 写入，在导出 10,000 条含独立图片的错题记录时，进程 RSS 峰值增量仅为 **+15.10 MB**（恢复增量 **+46.17 MB**），不会在桌面端或 NAS 小内存容器触发 OOM。（万题导出总时长约 54.6 秒主要来自 5,000 轮分片往返与逐项 ZIP 压缩，后台执行且内存平稳）。
3. **架构成本与收益比**：引入 `${DATA_DIR}/assets/` 与 `Asset` 表需同步承担文件孤儿清理、跨事务回滚一致性、旧字段双读迁移以及桌面端/安卓/NAS 数据目录迁移等复杂度；在当前单机家庭与班级场景（百至万题规模）下性价比不高。
4. **最终裁决**：**本阶段暂不实施 OPT-11b（维持 SQLite 存储 + 显式 `select` 字段裁剪 + v3 流式媒体归档）**；若后续单库向十万题或 GB 级高分辨率原图演进，再依据原方案启动双读与文件迁移。
