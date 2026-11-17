# 学迹优化路线图（定稿）

[English](optimization-roadmap.en.md)

| 项目 | 说明 |
| --- | --- |
| 定稿日期 | 2026-11-17 |
| 代码基线 | 分支 `feat/frontend-refactor-learning-path`，提交 `0ee3ffd` |
| 来源 | 三份审查草稿合并而成：原审查（R01–R16，详细设计 D1–D8）、评估方案（OPT-01–OPT-18）、扩展设计（E1–E7）。草稿未入库 |
| 范围 | 只有设计，不含代码改动。所有结论都对照过源码，但标注为“评估方案实测”的数据（覆盖率、文件数、耗时）没有在合并时重新测量 |
| 状态 | 已确认，作为后续实施的依据。实施中如果发现与本文冲突的事实，先更新本文再改代码 |

## 1. 结论摘要

- **架构不变**。继续使用 Next.js 全栈单体 + Prisma + SQLite 的自托管架构，不引入微服务、Redis、PostgreSQL 或向量库。所有问题都可以在现有架构内解决。
- **默认部署形态是家庭单账户**：一个家长账户，下面可以有多个孩子（`Learner`），部署在局域网或 NAS 上。排序原则是先保证数据不丢、AI 准确，再处理孩子之间的数据隔离；跨账户的安全加固放到后面，但满足[提前触发条件](#32-提前触发条件)时必须提前。
- **P0 只有一项**：生产环境的 stdout 日志会输出完整提示词和学生答案（`logger.box`）。其余问题按第 4 节重新定级。
- **交付阻塞**：当前分支有一个测试文件写入了本机用户目录，公开历史检查无法通过。这个问题不按安全等级定级，放进 Batch 0 第一个处理。
- **路线图共 Batch 0–G**。Batch 0–F 合计约 37–51 人日；只做到 Batch D（约 22–30 人日）时，家庭单账户场景的主要风险已经基本覆盖。

## 2. 已确认的决策

| # | 决策 | 结论 | 对实施的影响 |
| --- | --- | --- | --- |
| 1 | 默认部署形态 | 家庭单账户为主（一个家长账户，可有多个孩子，局域网/NAS 部署） | 按第 6 节排序；出现多账户、公网访问或启用 Openclaw 时，按 3.2 节提前加固 |
| 2 | 优先级校准 | P0 只有生产日志泄露提示词与学生答案；`subjectId` 越权和 R02 为 P1；管理员接口返回密码哈希或明文 Key 为 P2 | 引用任何 OPT 编号时，以本文第 5 节的定级为准 |
| 3 | AI 评测数据 | 只用合成题和公开题，不使用孩子的真实照片或笔迹 | `eval/datasets/` 可以进入公开仓库。手写和拍照场景通过合成方式覆盖：把公开题打印、手写、拍照，再加阴影、倾斜、透明底截图等处理。数据集 README 写明样本作者和授权协议 |
| 4 | 逐题复习算法 | 新增 FSRS 风格的逐题记忆模型，用 `algorithmVersion` 开关灰度上线，默认仍为 `ebbinghaus-v1` | 先在自家试用，对比到期题目的回忆正确率，再决定是否切换默认值。切换默认值单独提交，并同步中英文 README 和 Wiki |
| 5 | 安卓单机版图片处理 | 先验证 `@img/sharp-wasm32`（约 0.5 人日） | 可行就保留唯一的服务端裁剪逻辑，打包时剔除 x64 二进制；不可行再改走前端 Canvas。无论结果如何，结论都记入 OPT-13 |
| 6 | 文档归档 | 三份草稿合并为本文（`doc/design/optimization-roadmap.md` 与英文版），单独提交 | 草稿留在本地，不入库 |

## 3. 部署形态与风险模型

### 3.1 各部署形态的首要风险

| 部署形态 | 首要风险 | 优先处理 |
| --- | --- | --- |
| 家庭单账户，局域网/NAS（默认） | 数据丢失、迁移失败、AI 判错、孩子之间串数据 | OPT-22 每日快照、OPT-08 迁移前备份、OPT-04/09/19 AI 质量、OPT-07 孩子隔离、OPT-11a 备份 v3 |
| 家庭多账户或公网暴露 | 越权、会话无法撤销、暴力登录 | D1a 会话检查、`subjectId` 越权、R02、`TRUST_PROXY`、HTTPS |
| 教师多班级 | 同名学生串数据、重复导入 | OPT-07 教师部分（R07）、OPT-10 批改确认（R11） |
| 安卓单机版 | 设备丢失、没有备份、`sharp` 失效 | OPT-22、OPT-13、OPT-20 备份加密 |

注意：单账户不等于单学习者。一个家长账户下有多个孩子时，孩子之间串数据（判重、统计、复习、清空）是这种形态下最容易出现的正确性问题，因此 Batch C 专门处理。

### 3.2 提前触发条件

出现以下任一情况时，把 Batch F 中的 D1a 会话检查、`subjectId` 越权修复和 `TRUST_PROXY` 提到当前批次之前（三项合计约 1.5 人日）：

- 开放注册，或新增第二个账户；
- 通过公网或反向代理访问；
- 启用 Openclaw 集成。

建议在设置页的“系统信息”中检测这些状态并给出提醒（例如“检测到通过公网访问且未启用 HTTPS”），比只写在文档里更有效。

## 4. 优先级定义与发现登记

### 4.1 定级标准

| 等级 | 含义 |
| --- | --- |
| P0 | 默认配置下就会发生、没有前置条件、会造成数据外泄或不可恢复的损失，必须立即处理 |
| P1 | 需要一定前置条件才能利用的安全问题，或会直接导致数据错误、数据丢失、核心功能失效的正确性问题 |
| P2 | 纵深防御、调用方本身已有高权限的问题，或体验、性能、可维护性问题 |
| 交付阻塞 | 不是安全或功能问题，但会阻止推送、发布或 CI，按排期最先处理 |

### 4.2 主要发现（按定级）

下表只列出影响排期的发现，完整证据见各 OPT 条目。“部署形态”一列标出该问题在家庭单账户下是否需要优先处理。

| 定级 | 发现 | 位置 | 家庭单账户下 |
| --- | --- | --- | --- |
| P0 | 生产环境 `logger.box` 以 JSON 形式向 stdout 输出完整系统提示词、学生答案和原始响应，会进入 Docker 或 NAS 的日志 | [src/lib/logger.ts](../../src/lib/logger.ts)，四个 AI 提供商 | 优先 |
| 交付阻塞 | 单元测试写入了本机用户目录，`check-public-history.py` 失败，该分支的 `publication-check` 一直失败 | `src/__tests__/unit/user-data-dir.test.ts` 第 24、32 行 | 优先 |
| P1 | 偏好开关 `variantPipelineEnabled` 没有保存（R08） | [src/app/api/user/route.ts](../../src/app/api/user/route.ts) | 优先 |
| P1 | 语文、历史、地理、政治的知识点标签全部被过滤；`plausibleSubjectsForGrade(null)` 漏掉初高中理化生 | [src/lib/ai/knowledge-points.ts](../../src/lib/ai/knowledge-points.ts) | 优先 |
| P1 | `extractJsonObject` 遇到 LaTeX 单反斜杠（`\frac`、`\times`、`\neq` 等）会静默损坏或解析失败；多题解析时坏掉一题会静默丢题 | `src/lib/ai/schema.ts`、`src/lib/ai/parse-analyze.ts` | 优先 |
| P1 | 变式题答案比较与验算会放过错误结果：逗号一律当成“或”、`1=1` 常量方程通过、`2x` 无法处理、常数 `e` 被当成变量（R04） | [src/lib/variant/verify.ts](../../src/lib/variant/verify.ts) | 优先 |
| P1 | SQLite 没有设置 PRAGMA（`journal_mode=delete`、`busy_timeout=0`、`foreign_keys=0`）；`migrate-tags` 在事务中漏传 `tx` | `src/lib/prisma.ts`、`src/app/api/admin/migrate-tags/route.ts` | 优先 |
| P1 | 迁移前没有自动备份；`ErrorItem`、`PracticeRecord` 的正式迁移缺少 `learnerId` 外键（R06） | `packaging/runtime/launcher.js`、`prisma/migrations/` | 优先 |
| P1 | 判重、统计、复习、清空没有按孩子区分；创建孩子的数量上限有并发竞态；删除孩子不是原子操作（R03、R12） | `src/lib/` 判重与学习者服务、`src/app/api/stats/` 等 | 优先 |
| P1 | JSON 备份漏掉新业务表和 `VariantRun.stages`；`system-reset` 漏删新表（R05） | `src/app/api/export`、`src/app/api/import`、`src/app/api/admin/system-reset` | 优先 |
| P1 | 安卓单机版打包了 x64 的 `sharp`，在 arm64 设备上试卷裁剪静默失效 | `scripts/package/android-runtime.mjs` | 优先（安卓用户） |
| P1 | 透明 PNG 转 JPEG 后变黑底；不超过 1MB 的图片跳过缩放和方向修正 | `src/lib/image-utils.ts` | 优先 |
| P1 | 测试在高负载下偶发超时；`persona.test.ts` 运行中重建 Prisma Client 引发竞态；三条发布通路（release、packages、docker-build）没有同 SHA 门禁（R16） | `vitest.config.mts`、`.github/workflows/` | 优先 |
| P1 | `subjectId` 未校验归属，可写入其他账户的错题本 | [src/app/api/error-items/route.ts](../../src/app/api/error-items/route.ts) | 延后（触发条件出现时提前） |
| P1 | 请求恢复接口没有校验归属（R02）；禁用账户或改密后旧 JWT 仍然有效（R01） | `src/lib/current-user.ts`、`src/lib/auth.ts`、`recoverable-response` | 延后 |
| P2 | 管理员接口返回密码哈希；`/api/settings` 返回明文 Key | `src/app/api/admin/users/[id]`、`src/app/api/settings` | 延后 |
| P2 | `app-config.json` 权限不是 `0600`、写入非原子；`auth.ts` 硬编码 `debug: true`；登录邮箱未归一化 | `src/lib/config.ts`、`src/lib/auth.ts` | 部分优先（成本低，放 Batch 0） |
| P2 | Openclaw 入口缺少 `isActive` 检查、Key 比较不是常量时间、单图超时被压到过低 | `src/app/api/openclaw/batch-upload/route.ts` | 延后（启用 Openclaw 时提前） |
| P2 | 限流信任可伪造的 `CF-Connecting-IP` | `src/lib/rate-limit.ts` | 延后 |

评估方案中“Openclaw 认证静默降级”的定性偏重：未配置 API Key 时，入口会退回用户名密码校验，并没有跳过认证。真正的问题是缺少 `isActive` 检查、没有限流、按非唯一字段匹配用户。

## 5. 优化项

编号沿用评估方案的 OPT-01–OPT-18，新增 OPT-19–OPT-22（来自扩展设计 E1、E2、E5、E6）。扩展设计 E3 并入 OPT-12，E7 并入 OPT-09，E4 即第 3 节。每项给出定级、批次、要点、验收标准和依赖。

### OPT-01 · 拆分热修（Batch 0 与 Batch F）

评估方案把多项零迁移的单点修复放在一起。按决策 1 拆成两部分：

**Batch 0（与部署形态无关，成本低）**（已完成：`ec8ee57`、`3ecc30f`、`b2b6226`）

1. 测试文件中的本机用户目录改为 `check-public-history.py` 白名单允许的示例路径（`/Users/example/...`），第 32 行的用户名同步替换。【交付阻塞】（已完成：`ec8ee57`）
2. `PATCH /api/user` 补上 `variantPipelineEnabled`，响应返回服务端实际保存的值（R08）。【P1】（已完成：`3ecc30f`）
3. `src/lib/config.ts` 写入时使用 `{ mode: 0o600 }`；在同一个同步区间重新读取磁盘、合并后写入临时文件，再用 `renameSync` 原子替换；`generateId()` 改用 `crypto.randomUUID()`。【P2】（已完成：`b2b6226`）
4. `src/lib/auth.ts` 去掉硬编码的 `debug: true`，改为 `NEXTAUTH_DEBUG === 'true'`。【P2】（已完成：`b2b6226`）
5. `.gitignore` 增加 `*.db.bak-*`、`*.db.live-migrated-*`、`*.log.bak-*`（见 OPT-18）。（已完成：`ec8ee57`）

**Batch F（跨账户加固，已完成：`60600b9`）**

- `subjectId` 归属校验（`where: { id: subjectId, userId }`，跨用户返回 404），并修复 `error-items/[id]` 中空串无法解绑的问题。【P1】
- 定义 `USER_SAFE_SELECT`，管理员用户接口只返回安全字段，`isActive` 使用 zod 校验。【P2】
- Openclaw：未配置 Key 时拒绝；用 `crypto.timingSafeEqual` 比较；所有路径检查 `isActive`；单图超时设下限（或独立的 `OPENCLAW_IMAGE_TIMEOUT`）。【P2】
- 登录邮箱 `.trim().toLowerCase()`，兼容历史大小写账号；`https-server.js` 透传 `x-forwarded-proto` 和 `x-forwarded-for`。【P2】

**验收**：`check-public-history.py HEAD` 只剩历史对象问题（见 OPT-18）；偏好开关刷新后保持；POSIX 下 `app-config.json` 权限为 `0600`；Batch F 部分按评估方案的验收项执行。

### OPT-02 · 统一认证 Actor 与 `defineApiRoute` 包装器（P1/P2，Batch F，已完成：`c01b58b`、`afb9ac7`、`152547a`）

- **D1a 会话检查（P1，约 1 人日）**：`getCurrentUser` 和 `jwt` 回调按稳定的 `userId` 查询最新的 `isActive`、`role`。这一步不需要迁移，满足 3.2 节触发条件时最先提前。
- **完整方案**：`User` 新增 `authVersion`（改密、禁用、降权时在事务内递增）；`src/lib/server/actor.ts` 提供 `requireActor()` / `requireAdminActor()`；失效时返回 `401 SESSION_REVOKED | ACCOUNT_DISABLED`，前端防抖后自动登出（与 OPT-15 联动）。
- **包装器**：`defineApiRoute({ auth, maxBodyBytes, bodySchema }, handler)`。按实际读取的字节数限制请求体（不信任 `Content-Length`），用 `AsyncLocalStorage` 注入 `requestId` 和 `userId`。采用 Node 运行时的高阶函数，不用 `middleware.ts`（Edge Runtime 与 Prisma 不兼容）。路由迁移**按模块分散到各批次**，用 OPT-21 的路由清单测试跟踪进度，不一次性改约 100 个路由。
- **设置脱敏（P2）**：沿用服务端已有的 `'********'` 掩码约定，抽出公共的掩码与还原模块。`GET`/`POST /api/settings` 返回前对全部渠道密钥脱敏；`/api/ai/models`、`/api/ai/test` 收到掩码时从服务端读取真实密钥。必须处理一个回归场景：刚关闭“同多模态”开关、`textAi` 还没保存时，测试连接后再保存，真实密钥不能被还原成空串。前端需要向连接测试传递 `role` 和 OpenAI `instanceId`。
- **出站请求**：`/api/ai/models` 和 `/api/ai/test` 只允许 `http:`/`https:`，拒绝链路本地地址段和未指定地址，保留局域网地址（兼容 Ollama、vLLM），设置 15 秒超时并禁止重定向。
- **`TRUST_PROXY` 三态**：默认不信任 `CF-Connecting-IP`（只在 `TRUST_PROXY=cloudflare` 时读取）；`true` 时按 `TRUSTED_PROXY_HOPS` 取可信的末跳；`false` 时忽略全部代理头。
- **输入收口**：`originalImageUrl` 只接受空串或 `data:image/(png|jpeg|webp|gif);base64,...`（与 OPT-20 的 `normalizeImage()` 一起做）；`logs/frontend` 限制字段白名单和大小。

**验收**：禁用或改密后旧 JWT 返回 401 且前端自动登出；超限的分块请求体返回 413；伪造 `CF-Connecting-IP` 无法绕过限流；`/api/settings` 响应中没有明文 Key，掩码状态下保存局部设置和测试连接都正常（包括上面的回归场景）。

### OPT-03 · AI 提供商公共基座与日志防泄露（P0 部分 + P1，Batch 0 + Batch B）

- **Batch 0【P0】（已完成：`1f2edc1`）**：生产环境中 `logger.box` 不再输出正文，只记录溯源信息和长度；需要调试时，由显式的环境变量开启，并经过长度截断和脱敏。增加测试，断言生产模式的日志中不会出现 `data:image`、测试学生姓名和提示词片段。
- **Batch B【P1】（已完成：`a5fbbb4`）**：抽出 `base-xml-parser.ts` 和 `error-normalizer.ts`，统一四个提供商的标签解析（包括未闭合 `<analysis>` 的兜底）、`completeJson` 的异常捕获和 `AI_*` 错误码；Gemini 其余 13 个方法补上 `MAX_TOKENS` 截断重试；LongCat 的 `input_image` 适配覆盖所有带图方法；修正 Azure 传错的 `deployment` 参数和 `recognizeGrade` 漏传 `model`。不引入外部 AI SDK。

**验收**：四个提供商 × 核心方法的单测矩阵，在 401、429、超时、截断场景下返回统一错误码或自动重试成功；`NODE_ENV=production` 下日志不含完整提示词和学生答案。

### OPT-04 · 全学科标签与结构化解析加固（P1，Batch B，已完成：`3a203ae`）

- `SUBJECT_TAG_FIELDS` 覆盖全部 9 科，以 `SUBJECT_DISPLAY_NAMES` 为唯一来源；`plausibleSubjectsForGrade(null)` 返回全部学科；错题录入和详情按 `(name, subject)` 查找标签。
- `extractJsonObject` 在**第一次 `JSON.parse` 之前**运行一遍字符串感知的修复：只处理字符串内的反斜杠；跳过已经双写的 `\\`；保留 `\"`、`\/` 和合法的 `\uXXXX`；对 `\b`、`\f`、`\n`、`\r`、`\t` 这五个本身合法、会被静默解析成控制字符的转义，只在后面紧跟已知 LaTeX 命令名时补成双反斜杠。`\n` 只匹配 `neq`、`nabla`、`notin` 等命令，不影响正常换行；`\t` 的词表不包含 `to`，避免误改制表符文本。第一次解析仍失败时，才执行第二遍（清理尾逗号、转义字符串中的裸换行）。
- `parseAnalyzeResponse` 返回 `{ items, failedCount }`，失败的题目记 `warn` 并提示前端。

**验收**：9 科标签过滤结果都不为空；`\frac{1}{2}`、`\times 2`、`\begin{aligned}`、`\binom{4}{2}`、`\neq 0`、`\right)`、`\sqrt{2}` 解析无损，已双写的 `\\frac` 不被重复处理，`解：\n第一步` 保持真实换行；多题中坏掉一题时返回其余题目且 `failedCount=1`。以上用例同时进入 OPT-19 的评测集。

### OPT-05 · 测试隔离与发布门禁（P1，Batch A，已完成：`5d9e4e6`）

> 说明：迁移漂移检查 `scripts/check-migration-drift.mjs` 已接入 CI 与 `scripts/ci.sh`，现存 `ErrorItem`/`PracticeRecord` 外键历史漂移将在 Batch C 的 OPT-08 外键迁移完成后归零。

- Vitest 5 已移除 `environmentMatchGlobs`，改用 `test.projects`：`dom` 项目（29 个 `.test.tsx` 加 6 个依赖 DOM 的 `.test.ts`）与 `node` 项目（其余单元测试和集成测试）。评估方案实测 jsdom 创建次数从 186 次降到 35 次。`src/__tests__/setup.ts` 中的 `localStorage` 模拟加上 `typeof window` 守卫。
- 移除 `persona.test.ts` 在运行时调用的 `prisma generate`（或改为输出到独立的临时目录），消除并发重建 Prisma Client 引发的初始化错误。
- `tests/publication` 的测试显式把 `core.excludesfile` 设为空设备，不受开发者全局 gitignore 影响。
- CI：E2E 改用 `prisma migrate deploy` 建库；新增 `prisma migrate diff --exit-code` 拦截迁移漂移；`scripts/ci.sh` 增加 `tsc --noEmit` 并改跑覆盖率。
- 发布门禁：抽出公共的 `verify-ci-gate` action，`release.yml`、`packages.yml` 和 `ci.yml` 的 `docker-build` 在打 `v*` 标签时，都要求同一 SHA 存在一次已完成的 `ci.yml` 运行，且所有必需 Job 的结论为 `success`（明确拒绝 `skipped`，因为标签推送也会产生一次测试被跳过的运行）。

**验收**：`tsc --noEmit` 通过；`npm run test:unit` 连续 5 次退出码为 0；全量并发运行不再出现 Prisma 初始化错误；只有被跳过的运行而没有全绿运行时，三条发布通路都拒绝发布；漏建迁移的 schema 变更被 CI 拦截。

### OPT-06 · SQLite 引擎配置与事务规范（P1，Batch A，已完成：`150ac2f`）

按顺序实施，避免在单连接池下因漏传 `tx` 而死锁：

1. **先修事务签名**：`migrate-tags` 传入 `tx`；去掉 `tag-recognition.ts`、`notebook-resolver.ts` 中的 `= prisma` 默认参数，数据访问函数统一要求显式传入 `db`。OPT-21 的 ESLint 规则禁止在 `$transaction` 回调中引用全局 `prisma`。
2. **再统一连接**：`src/lib/prisma.ts` 中，对未声明 `connection_limit` 的 `file:` URL 注入 `connection_limit=1`，连接初始化时设置 PRAGMA；`launcher.js` 和 `docker-entrypoint.sh` 对齐。
3. **日志模式可配置**：`SQLITE_JOURNAL_MODE` 白名单，默认 `WAL` + `synchronous=NORMAL` + `busy_timeout=5000` + `foreign_keys=ON`；NAS 上的 NFS/CIFS 网络卷可以改为 `DELETE` 或 `TRUNCATE`，此时自动使用 `synchronous=FULL`。同步 `.env.example` 和备份 Wiki。

**验收**：启动后实测 PRAGMA 与配置一致；10 个并发读加 3 个并发写零 `SQLITE_BUSY`；`migrate-tags` 集成测试通过。

### OPT-07 · 学习者作用域隔离与档案治理（P1，Batch C + Batch F）

- **Batch C（孩子之间，已完成：`bea3a21`）**：`LearningScope = { userId, learnerId }` 覆盖判重、重复练习、统计、清空、复习和 Openclaw 入口（R03）；创建孩子在事务中原子检查数量上限；删除孩子默认软归档（`archivedAt`），或在单个事务中硬删除全部相关数据（R12）。
- **Batch F（教师端，R07，已完成：`a16b1e4`）**：不再按姓名匹配错题本或用 `OR` 合并，新写入严格按 `learnerId` / `gradingStudentId` 关联；历史归属按原审查 D2 的流程修复（只读盘点、导出歧义清单、唯一可确定的自动回填、歧义由人工确认、写审计日志）。

**验收**：两个账户、各两个孩子、加上跨班同名学生的矩阵下，录入、判重、统计、复习、清空完全隔离；10 个并发创建请求最多成功 3 个；删除中途注入异常后没有残留的半完成数据。依赖 OPT-06、OPT-08 外键迁移。

### OPT-08 · 迁移前备份与外键迁移（P1，Batch A + Batch C，已完成：`d45ccda`、`0812330`）

- **Batch A：迁移前自动备份与启动保护（已完成：`d45ccda`）**。在 `launcher.js` 的 `prepare()` 中，`migrate deploy` 之前、服务启动之前：如果 `-wal` 文件非空，用随包的 `@prisma/client` 临时连接执行 `wal_checkpoint(TRUNCATE)`（先把 `PRISMA_QUERY_ENGINE_LIBRARY` 同步到 `process.env`，显式传入数据库 URL，`finally` 中断开连接），然后把 `.db` 原子复制为 `backups/pre-migrate-<version>-<ts>.db`，保留最近 3 份；如果没能清空 `-wal`，就把 `.db`、`-wal`、`-shm` 三个文件一起复制到单独目录，并写恢复说明。迁移失败时打印恢复指引并拒绝启动。`instrumentation.ts` 中的 `applyLearnerBackfill` 加幂等完成标记，不再每次冷启动都执行；修复 fnOS 安装回调吞掉错误的问题，升级回调补上备份。
- **Batch C：外键迁移（已完成：`0812330`）**。先运行只读的旧库审计脚本（`scripts/audit-learner-foreign-keys.mjs`），处理孤儿 `learnerId`（记入 `LearnerBackfillAudit` 并安全置空），用 `PRAGMA defer_foreign_keys=ON` 重建 `ErrorItem` 和 `PracticeRecord`，保留全部列和索引，补上 `ON DELETE SET NULL` 外键（R06），迁移漂移归零。

**验收**：在包含 1 万道错题和非空 `-wal` 的旧版样本库上，自动生成完整的备份（包含 `-wal` 中已提交的事务）；迁移后 `prisma migrate diff` 退出码为 0，`PRAGMA foreign_key_check` 为空；`/api/health` 冷启动就绪时间少于 15 秒。回滚使用事前备份加旧版本安装包，不做会丢列的 down 迁移。

### OPT-09 · 变式流水线与数学验算（P1，Batch B；含 E7，已完成：`448ffd9`）

- 变式出题提示词注入通用的出题、LaTeX、SVG 规则，`variant/pipeline.ts` 调用 `normalizeGeneratedQuestion` 拦截选择题和题号分值；写入和复制前统一调用 `sanitizeFigureSvg`。
- `svg-animation.ts` 中 `buildSvgAnimationDocument` 拼接 HTML 前先调用 `sanitizeSvgAnimation`；由于提取逻辑取第一个 `<svg` 到最后一个 `</svg>`，中间可能夹带 `</body>`、`</html>`，应直接拒绝这类结构标签；如果选择剥离，必须循环剥离到不再变化，防止 `</bo</body>dy>` 这类嵌套构造重组。当前前端以 `<img src=data:...>` 渲染 SVG，脚本不会直接执行，这一项属于纵深防御和导出场景的保护。
- 答案按 `scalar | tuple | set | text` 解析，取消“逗号一律当成或”（元组按位比较，集合双向完整匹配，多小问按题号匹配）；`verifyComputable` 同时校验计算结果与 `expected`、`expected` 与 `answerText` 是否一致（R04）。
- `equationHolds`：支持隐式乘法（`2x` → `2*x`）；要求表达式至少包含一个自由变量（拒绝 `1=1`）；多字母变量按变量名替换；**常数 `e` 不能被当成变量替换**（E7）；`verifyComputable` 中 numeric 分支与普通分支的两个结果完全相同，numeric 类型实际上没有被单独处理，需要补上（E7）。缺少 `difficultyConsistent === true` 或核心证据时不得标记为已验证。

**验收**：原审查 D4 的全部反例（缺根、坐标不同、`1=1`、`2x=6`、`expected` 与 `answerText` 冲突、跳过难度检查）加上 `e` 常数用例全部通过，并进入 `eval/datasets/verify/`；含 A/B/C/D 或 `<script>` 的变式被拒收或净化；含 `</body><script>`、`onload`、`javascript:` 的 SVG 载荷无法逃逸。

### OPT-10 · 批改确认竞态与统一作业表（P2，Batch F，已完成：`fa435f4`、`7ce1664`）

- 家长和教师的批改确认在短事务内用条件更新抢占状态（`updateMany` 带 `status` 和 `version` 条件），新增 `SourceImport(userId, sourceKind, sourceQuestionId)` 唯一约束防止重复导入；耗时的图片裁剪放在事务外，提交前核对源版本，冲突返回 409（R11）。
- 用一张 `AsyncOperation` 表统一原审查 D3 的幂等表、现有的 `recoverable-response` 内存缓存和 `background-tasks`（淘汰 `config/background-tasks.json`）：`(userId, kind, idempotencyKey)` + `requestHash`，同键同内容复用结果，同键异内容返回 409，跨用户返回 404（R02）。**第一版不做租约和心跳**：单实例部署下，重启时把运行中的任务标记为 `interrupted` 已经足够。
- `AiDailyQuota(userId, dayKey)` 原子预留额度；`ai/concurrency.ts` 增加排队上限、排队超时和取消，超限返回 `429/503 + Retry-After`（R09、R15）。

**验收**：同一幂等键并发 20 次只写入一次；批改确认并发 10 次只生成一套错题；额度剩 1 时并发 20 次只放行 1 次；重启后运行中的任务状态正确。依赖 OPT-02、OPT-06。

### OPT-11 · 备份 v3（拆为 11a 与 11b）

**OPT-11a · 流式 ZIP 备份 v3（P1，Batch D，已完成：`01fec89`、`b02986f`）**

- 复用已有依赖 `fflate`，导出为流式 `.zip`：`manifest.json`（`formatVersion: 3`、各实体计数、SHA-256 摘要）+ `data/*.ndjson` + `media/<sha256>`。导出时直接把 `data:` URL 拆成媒体文件，**不依赖 Asset 表**。
- 补全 `Learner`、`ParentPaper*`、`Grading*`、`VariantRun.stages`、`KnowledgeMastery`、`LearningPath*`，修正 `importAll` 中硬编码的 `VariantRun.userId`（R05）。可重算的派生状态（掌握度、记忆模型）单独归类，导入后可以重建。
- 遗留的 `ReviewSchedule` 表：业务代码已不读写，只在导出导入中出现。v3 导入时转换或忽略旧数据并给出提示，下一个大版本的迁移中删除该表。
- 保持 v1/v2 JSON 导入兼容，并说明旧格式的能力边界。可选口令加密见 OPT-20。
- `admin/system-reset` 清理全部业务表和磁盘缓存，只保留当前管理员账号和 `isSystem: true` 的系统知识点树。
- 同步更新 `src/app/api/export`、`src/app/api/import`、`data-backup.test.ts` 和备份 Wiki（中英文）。

**OPT-11b · Asset 文件存储（P2，Batch G，视基准结果决定）**：按原审查 D8 的原则，等 OPT-17 的基准数据出来后再决定是否把图片从数据库迁到 `${DATA_DIR}/assets/`。如果实施，采用“双读、校验、保留旧字段一段时间”的平滑迁移，并提供鉴权的 `/api/assets/:id`。`/api/tts/:id` 的归属校验不依赖 Asset，已在 Batch F 完成（`60600b9`）。

**验收（11a）**：500MB 含图样本库导出、空库导入，RSS 峰值增量小于 150MB；v3 往返后全部实体数量、学习者归属、`stages`、媒体 SHA-256 完全一致；`system-reset` 后业务表和缓存为空。依赖 OPT-07、OPT-08。

### OPT-12 · 掌握度统一与逐题记忆模型（P1 + P2 灰度，Batch E；含 E3，已完成：`6b0282f`、`6fa9ff1`）

**12a · 知识点层（P1）**

- `mastery-model.ts` 的 `dueAt` 改由 BKT 加幂律的 `stabilityDays` 按目标可提取性 0.85 计算，限制在 1–180 天之间，取代硬编码的间隔回退。这会**改变现有的“毕业”契约**：原来连续答对 7 次后不再复习，改为已观测的知识点最长每 180 天复习一次，或者明确以 `stabilityDays >= 180 && pKnown >= 0.9` 作为毕业条件。需要同步更新 `learning-path.test.ts`。
- 证据排序增加稳定的决胜键（`itemId`、`correct`），消除同一毫秒内多题证据的顺序不确定。
- 取消录题时的冗余入队，以及判重命中、作答练习后隐式逐题调用 AI 的 `evaluateMastery`，改为用户手动触发或低频汇总。
- 删除按拼音排序添加伪先修边的逻辑，只保留 `parentId` 树边和显式先修配置；`subjectId` 过滤只作用于展示；`GET /api/learning-path` 改为只读；`error-items/route.ts` 补传 `learnerId`；`listClassPaths` 合并为一次证据加载（R13）。

**12b · 逐题记忆模型（P2，灰度，决策 4）**

- 新增 `ItemMemory(learnerId, errorItemId, stability, difficulty, lastReviewAt, dueAt, reps, lapses, algorithmVersion)`，用 FSRS 风格的更新公式和公开默认参数，纯 TypeScript 实现，不引入新依赖。`algorithmVersion` 默认 `ebbinghaus-v1`。
- 分工：BKT 的 `pKnown` 决定学什么（学习路径），记忆模型决定什么时候复习（今日待复习），知识点的可提取性由其下题目聚合得出。首页和学习路径共用 `getDueItems(scope, date)`，避免两处到期提示互相矛盾。
- `PracticeRecord` 是唯一的证据来源，记忆状态都可以重算。
- 效果度量：在复习量不增加的前提下，比较到期题目的回忆正确率，不预设目标数值。

**验收**：录题、判重命中和作答练习不再隐式调用 AI；同毫秒证据排序确定；学习路径测试按新契约通过；`GET /api/learning-path` 命中缓存时数据库零写入；`listClassPaths` 30 名学生时 SQL 查询数下降至少 50%；`algorithmVersion` 两种取值下“今日待复习”都正确。依赖 OPT-07。

### OPT-13 · 安卓 `sharp` 与多端冒烟（P1，Batch D，已完成：`76aac87`）

1. **已完成 `@img/sharp-wasm32` 验证**：在阻断一切非 `wasm32` 原生 `@img/sharp-*` 模块的 Node 环境中实测，`@img/sharp-wasm32`（`0.35.5` + `@emnapi/runtime` `1.11.3`）冷加载约 93ms，1800×2400 模拟试卷 `normalize` 约 51ms、`autoCrop` 约 160ms、单题裁剪约 11ms，`node_modules/@img/sharp-wasm32` 体积约 8.9MB，可稳定运行。
2. 决定保留唯一的服务端裁剪路径：`android-runtime.mjs` 导出 `prepareAndroidServerTree` 清理全部非 `colour`/`sharp-wasm32` 的平台 `@img/*` 原生包，并补齐 `@img/sharp-wasm32` 及 `@emnapi/runtime` 等纯 JS/WASM 运行时，不再引入前端 Canvas 第二套裁剪逻辑。
3. 已扩充 `package-launcher.test.ts`（首次复制 `seed.db`、增量迁移与迁移前备份、`installExternalAliasResolver` 别名解析）并新建 `android-sharp-runtime.test.ts`；`.github/workflows/packages.yml` 已补充桌面解包 `/api/health` 启动冒烟、fnOS 生命周期及升级备份冒烟、安卓 `server.zip` 结构断言。

**验收**：`server.zip` 中无 `linux-x64` 等原生二进制；安卓单机版框选切题与自动裁边由 `sharp-wasm32` 正常执行且不再回退保存整页原图；桌面产物启动后 `/api/health` 返回 `ok`。

### OPT-14 · 前端首屏减负（P2，Batch E，已完成：`38483c9`）

- `app-shell.tsx` 用 `next/dynamic` 懒加载 `SettingsDialog`，内部标签页按激活状态渲染。
- 翻译拆为 `translations/types.ts`、`zh.ts`（静态内嵌，保持 `useSyncExternalStore` 同步水合，无闪烁）、`en.ts`（切换时按需加载，先写入缓存再通知），`index.ts` 供测试使用；`api-client.ts` 和 `question-deduplication.ts` 不再整体导入翻译表，避免英文词典回流首屏。
- `MarkdownRenderer` 加 `React.memo`，用 `useMemo` 缓存 `prepareMarkdownMath`；主要路由段补 `loading.tsx` / `error.tsx`；打印预览分批加载图片；超过 200 行的组件随功能改动逐步拆分。

**验收**：首页客户端 chunk 不含管理员组件和英文词典；切换英文时单独请求 `en` chunk 且没有水合错误；`translations.test.ts` 通过。

### OPT-15 · 客户端协议、图片处理与可访问性（P1，Batch E，已完成：`f4c7547`）

- `api-client.ts`：响应体只读一次并按类型解析，204 单独处理，意外的非 JSON 响应抛协议错误；用 `AbortSignal.any` 合并外部信号和超时；只在有 JSON 请求体时设置 `Content-Type`；处理 `SESSION_REVOKED` / `ACCOUNT_DISABLED`（与 OPT-02 联动）；`use-practice-session` 补齐 AI 错误码映射。
- `image-utils.ts`：转 JPEG 前先填充白色背景；小于 1MB 的图片也检查尺寸和方向。
- 设置对话框共享一个用户资料上下文，消除并发 4 次 `GET /api/user`；`current-child.ts` 按 `userId` 隔离；`learn/page.tsx` 重试时传入正确的 `studentKey`；`<html lang>` 默认 `zh-CN` 并随语言切换；移动端设置标签补 `aria-label`；通知权限改为用户触发耗时识别时再请求。

**验收**：透明 PNG 压缩后背景为白色；打开设置只发 1 次 `GET /api/user`；`apiClient` 纯文本 500、信号合并、会话撤销自动登出的单测通过；`html[lang]` 随语言切换。

### OPT-16 · 高风险覆盖率与三角色 E2E（P2，Batch G）

- 先补后端单测和集成测试：`grading/*`（评估方案实测 0% 覆盖）、家长试卷标注与汇总、`error-items/list`、`ai/test`、`admin/migrate-tags`、`admin/system-reset`、SVG 逃逸边界，然后逐步提高 `vitest.config.mts` 的覆盖率阈值。
- 新增 4 条 Playwright 用例（包括 390px 移动视口）：双账户多孩子同名学生隔离；家长上传试卷、框选、核对、确认入库；教师批改、确认入库、学习路径；备份 v3 导出、系统重置、导入还原。
- 双租户测试工具和备份覆盖测试已在 Batch C 由 OPT-21 提供，这里直接复用。

**验收**：`grading/*` 和 `error-items/list` 行覆盖率至少 70%；E2E 运行在 `migrate deploy` 建成的数据库上并全部通过。

### OPT-17 · 性能基准与运营指标（P2，Batch G）

- 合成基准脚本：1,000 / 10,000 题、1 / 3 个孩子、30 / 100 名学生、多页试卷；采集列表、学习路径、导入导出、批改确认的 p50/p95/p99、SQL 次数、RSS 和排队等待时间。
- 根据实测查询计划再决定是否加复合索引，不预先加索引。
- 运营指标：任务成功、失败、未知的比例，AI 提供商 429 比例，队列饱和度，外键一致性检查状态，以及按 `provenanceId` 分组的“用户手动修改 AI 识别结果的比例”（OPT-19 的线上信号）。

**验收**：基准脚本可复现；普通列表和详情 p95 不超过 500ms，缓存后的学习路径 p95 不超过 1s（不含 AI 耗时）。

### OPT-18 · 公开历史、工作区卫生与文档债（交付阻塞 + P2）

- **工作区卫生（Batch 0，已完成：`ec8ee57`）**：本地的数据库备份和日志备份移出仓库（需要保留作迁移测试样本的，先确认不含真实数据）；`.gitignore` 增加对应规则，不覆盖 `prisma/migrations/` 和测试夹具。
- **历史对象（合入 `main` 时）**：提交 `48e96ed` 引入的对象已经在公开远端的特性分支上，只追加新提交无法消除。采用**路径 A**：合入 `main` 时 squash，或从 `main` 重建干净分支，保证 `main` 只包含干净的提交，不重写已推送的特性分支。**路径 B**（交互式变基重写 `48e96ed..HEAD` 并强推）必须由用户单独确认。
- **文档债**：`doc/wiki/` 内容仍停留在单用户阶段。随各批次同步更新受影响的页面（例如 Batch A/D 更新备份与恢复页的 WAL、快照、v3 范围），功能合入 `main` 前补齐多孩子、家长试卷、教师批改、学习路径、多端安装排障的中英文页面和官网说明。

**验收**：`git status` 中没有本地备份文件；合入后 `check-public-history.py main` 退出码为 0；Wiki 中英文页面覆盖已上线功能。

### OPT-19 · AI 质量评测与溯源（P1，Batch B；来自 E1，已完成：`d67925e`）

OPT-03、OPT-04 修复了提供商之间的行为差异，但仍然回答不了“换模型或改提示词之后效果是变好还是变差”。仓库只有冒烟脚本，数据库中也没有记录某条 AI 结果来自哪个提供商、模型和提示词版本。

**溯源**

```prisma
model AiProvenance {
  id            String   @id @default(cuid())
  task          String   // analyze | grade | exam-read | variant | tag ...
  provider      String   // gemini | openai | azure | anthropic | 渠道预设名
  model         String
  promptVersion String   // prompts.ts 中该提示词规范化文本的哈希前 12 位
  parserVersion String   // 解析与校验逻辑的版本
  createdAt     DateTime @default(now())
  @@unique([task, provider, model, promptVersion, parserVersion])
}
```

相同组合复用同一行，写入成本几乎为零。AI 产出的记录（`ErrorItem`、家长试卷题、批改结果、`VariantItem`）增加可空的 `provenanceId`，旧数据不回填。`promptVersion` 在构建时由 `prompts.ts` 自动计算，不靠人工维护版本号。token 和耗时记在 OPT-10 的用量表中，不重复计数。新字段需要同步导出导入（OPT-11a）。

**离线评测**

```
eval/
  datasets/{analyze,grading,exam-read}/   # 图片 + 人工标注，需要调用真实 AI，不进 CI
  datasets/verify/                         # 纯文本答案等价用例，进单元测试
  run-eval.ts                              # 按 task × provider × model 运行，输出 JSON 和 Markdown
  baselines/
```

- 数据只用合成题和公开题（决策 3），入库前去除元数据；首批每类 30–50 例。
- 指标：题干编辑距离、答案完全匹配率、9 科标签 F1（直接验证 OPT-04）、批改准确率、**把错题判成对的比例**（批改场景最需要避免的错误）、JSON 解析失败率、p95 耗时、单题成本。
- 规则：凡是修改 `prompts.ts`、解析器或默认模型的 PR，都要附评测报告；关键指标下降超过阈值（初始建议 2 个百分点）时必须说明原因。

**验收**：`run-eval.ts` 能对至少两个提供商输出报告并与基线比较；新增的 AI 产出记录都带 `provenanceId`；`datasets/verify/` 用例在 `npm run test:unit` 中运行。

### OPT-20 · 儿童数据隐私（P1/P2，Batch B、D、G；来自 E2）

使用者主要是中小学生。目前服务端会把原图原样入库，例如 Openclaw 入口直接拼接 `data:` URL（`src/app/api/openclaw/batch-upload/route.ts`），照片中的 GPS 和设备信息会被长期保存并随导出扩散。

| 项 | 设计 | 定级 | 批次 |
| --- | --- | --- | --- |
| 服务端图片规范化 | 所有入口（识别、Openclaw、家长试卷、教师批改）统一经过 `normalizeImage()`：sharp 解码，按方向旋转，**去除全部元数据**，限制最长边，重新编码；同时检查真实 MIME 和像素上限（OPT-02 只限制字节数）。前端压缩只是优化，服务端处理才是安全边界。`originalImageUrl` 协议校验一起完成 | P1 | B（已完成：`b2d6a3f`） |
| 备份加密 | ZIP v3 支持可选口令加密（AES-256-GCM，用 scrypt 从口令派生密钥），manifest 中明文记录加密参数；未加密导出时给出提示 | P2 | D（已完成：`9cbee2b`） |
| 自助删除 | `DELETE /api/user`：要求重新输入密码，先引导导出，然后在一个事务中删除全部数据（依赖 OPT-08 外键），只写一条不含个人信息的审计记录；管理员删除用户复用同一服务 | P2 | G |
| 数据去向告知 | 在设置页和 `doc/PRIVACY*.md` 写明图片会发送给当前配置的 AI 提供商，列出是哪一家，并提示可以改用本地模型端点 | P2 | G |

日志脱敏属于 OPT-03 的 Batch 0 部分。

**验收**：带 GPS 的测试图片经任一入口入库后不含 EXIF；加密备份没有口令无法导入，口令正确时往返一致；自助删除后该用户的业务表为空。

### OPT-21 · 防复发护栏（随对应修复交付；来自 E5）

护栏和它要防止的问题放在同一个提交中。

| 护栏 | 实现 | 防止 | 批次 |
| --- | --- | --- | --- |
| 日志断言测试 | 生产模式下日志不含 `data:image`、测试学生姓名、提示词片段 | 日志泄露回退 | 0（已完成：`1f2edc1`） |
| 偏好往返测试 | 根据 `userUpdateSchema` 的键自动生成 PATCH→GET 往返用例 | R08 同类问题 | 0（已完成：`3ecc30f`） |
| ESLint 事务规则 | 禁止在 `$transaction` 回调中引用全局 `prisma` | OPT-06 漏传 `tx` | A（已完成：`150ac2f`） |
| 双租户测试工具 | `withTwoTenants()` 自动创建两个账户、两个孩子和同名学生，断言跨作用域访问返回 404 | R03、R07、越权 | C（已完成：`bea3a21`） |
| 备份覆盖测试 | 通过 Prisma DMMF 枚举全部模型，每个模型必须出现在“导出”或“明确不导出”清单中 | R05 回退 | C（已完成：`f6bb37f`） |
| system-reset 覆盖测试 | 同样基于 DMMF，断言重置后所有业务表为空 | 漏删新表 | D（已完成：`01fec89`） |
| 路由清单测试 | 扫描 `src/app/api/**/route.ts`，要求导出的处理函数都由 `defineApiRoute` 包装，并与 `api-auth-inventory.json` 快照对比；新增公开路由必须显式登记 | 绕过鉴权 | F（已完成：`c01b58b`） |
| ESLint 会话规则 | `src/app/api/**` 禁止直接导入 `getServerSession` | R01 回退 | F（已完成：`c01b58b`） |

备份覆盖、偏好往返和 system-reset 覆盖三项成本很低，把 AGENTS.md 中“新增字段要同步导出导入”从约定变成了机器检查。

### OPT-22 · 每日快照（P1，Batch A；来自 E6，已完成：`1c0ab8b`）

OPT-08 只在迁移前备份一次。补充：

- 每天用 `VACUUM INTO` 生成一致性快照，存到数据目录的 `backups/` 下，默认保留 7 份（WAL 模式下同样安全）；
- 设置页显示最近一次成功的时间，失败时在首页提示；
- 安卓单机版和 fnOS 默认开启；Docker 部署可通过环境变量关闭（例如已经有卷快照的用户）。新增环境变量同步 `.env.example`。

这是整站恢复最简单、最可靠的保障，与面向数据迁移的 ZIP v3 互补。

**验收**：连续运行时只保留最近 7 份；快照文件可以直接作为数据库启动，且通过 `PRAGMA integrity_check`；快照失败时首页出现提示。

## 6. 路线图

每个独立需求单独提交，护栏与对应修复放在同一个提交中，每个提交都要能独立通过测试，并包含对应的测试与文档改动。工作量是一名熟悉项目的工程师的粗略估计，包含测试和文档同步。

| 批次 | 目标 | 内容 | 预估（人日） | 排序理由 |
| --- | --- | --- | --- | --- |
| **Batch 0 止血**（已完成：`ec8ee57`、`3ecc30f`、`b2b6226`、`1f2edc1`） | 恢复公开历史检查，堵住日志泄露 | OPT-01 的 Batch 0 部分（测试路径、R08、`config.ts`、`debug`）；OPT-03 日志静默；OPT-18 工作区卫生；OPT-21 日志断言和偏好往返测试 | 1.5–2 | 成本低、收益确定，与部署形态无关；不恢复公开历史检查，后续所有推送都会被阻止 |
| **Batch A 数据不丢**（已完成：`150ac2f`、`d45ccda`、`1c0ab8b`、`5d9e4e6`） | 家庭用户没有运维能力，先保证可恢复 | OPT-22 每日快照；OPT-08 迁移前备份与启动保护；OPT-06；OPT-05 | 4–6 | 后续所有迁移都依赖这层保障 |
| **Batch B AI 质量**（已完成：`3a203ae`、`a5fbbb4`、`448ffd9`、`b2d6a3f`、`d67925e`） | 识别、标签、判题准确 | OPT-04；OPT-03 提供商一致性；OPT-19 溯源与评测；OPT-09（含 E7）；OPT-20 `normalizeImage()` | 7–9 | 家庭用户每天直接感受到的就是准确率 |
| **Batch C 孩子之间隔离**（已完成：`0812330`、`bea3a21`、`f6bb37f`） | 多孩子家庭的正确性 | OPT-08 外键迁移（只读审计与外键重建）；OPT-07 孩子部分；OPT-21 双租户工具和备份覆盖测试 | 5–7 | 单账户下最容易发生的串数据 |
| **Batch D 可迁移备份**（已完成：`01fec89`、`b02986f`、`9cbee2b`、`76aac87`） | 换设备、迁移 NAS | OPT-11a（含 `ReviewSchedule` 处理和 system-reset）；OPT-20 备份加密；OPT-13（已验证 wasm）；OPT-21 system-reset 覆盖测试 | 5–7 | 家庭用户的主要恢复场景 |
| **Batch E 学习效果与体验**（已完成：`6b0282f`、`6fa9ff1`、`f4c7547`、`38483c9`） | 复习与日常使用 | OPT-12a；OPT-12b 灰度；OPT-15；OPT-14 | 7–10 | 依赖 Batch C 的学习者作用域 |
| **Batch F 多账户与加固**（已完成：`60600b9`、`c01b58b`、`afb9ac7`、`152547a`、`a16b1e4`、`fa435f4`、`7ce1664`） | 跨账户安全 | OPT-02（D1a 优先，包装器按模块迁移）；OPT-01 的 Batch F 部分；OPT-07 教师部分；OPT-10；`/api/tts/:id` 归属校验；OPT-21 路由清单与会话规则 | 8–11 | 家庭单账户下风险低；满足 3.2 节条件时整体或部分提前 |
| **Batch G 按需** | 长期质量 | OPT-16；OPT-17；OPT-11b（视基准）；OPT-20 自助删除与数据去向告知；OPT-18 文档债收口 | 另估 | — |

Batch 0–F 合计约 **37–51 人日**；做到 Batch D 约 **22–30 人日**。评估方案的 Batch 0–D 为 24–33.5 人日，差异主要来自：OPT-02 的路由迁移不再压在一个批次内、新增 OPT-19–OPT-22，以及 OPT-12b。

### 依赖关系

```
Batch 0 ──► Batch A ──► Batch B
              │
              ├──► OPT-06 ──► OPT-08 外键（Batch C）──► OPT-07 孩子部分 ──► OPT-11a（Batch D）
              │                                              │
              │                                              └──► OPT-12a/12b（Batch E）
              └──► OPT-05 门禁保护之后所有批次
OPT-13 wasm 验证 ──► OPT-11a 中安卓存储路径
OPT-02 D1a ──► OPT-02 完整方案 ──► OPT-10、OPT-15 会话撤销处理
OPT-17 基准 ──► OPT-11b 是否实施、是否加索引
```

Batch B 与 Batch C 之间没有强依赖，人手充足时可以并行。

## 7. 实施约定

- **迁移**：修改 `prisma/schema.prisma` 一律使用正式迁移，并兼容已有数据（生产以 `PRESERVE_EXISTING_DATA=true` 运行）。涉及重建表的迁移，先有 OPT-08 的迁移前备份和 OPT-22 的每日快照，再发布。
- **备份字段**：新增需要备份的字段或表（如 `provenanceId`、`ItemMemory`、`AsyncOperation`），同步更新导出、导入和 `data-backup.test.ts`；Batch C 之后由备份覆盖测试强制检查。
- **AI 改动**：同步修改四个提供商，提示词集中在 `prompts.ts`；Batch B 之后附 OPT-19 评测报告。
- **文档同步**：功能、配置项或默认值变化时，同步 `README.md`、`README.en.md`、受影响的 `doc/` 和 `doc/wiki/` 中英文页面；面向用户的变化同步官网项目。
- **本文维护**：每完成一个优化项，在本文对应条目后注明完成的提交；范围或定级变化时先改本文。

## 8. 未验证的边界与暂缓事项

**合并时未重新测量**

- 覆盖率数字、测试文件数（35 / 151 的拆分）、jsdom 创建次数、组件行数等，来自评估方案实测，实施时以当时的实测为准。
- `@img/sharp-wasm32`（`0.35.5` + `@emnapi/runtime`）已在禁用原生 `@img/sharp-*` 模块的 Node 环境中实测验证加载、规范化、自动裁边与单题裁剪耗时与约 8.9MB 包体积；安卓真机物理耗时可在发布预览包时复核。
- 网络卷（NFS/CIFS）上 WAL 模式的实际表现没有测试，`SQLITE_JOURNAL_MODE` 的默认值可能需要按 NAS 用户的反馈调整。

**明确暂缓**

- 不引入 Redis、PostgreSQL、消息队列或微服务。
- 不引入外部 FSRS 或 AI SDK 依赖。
- `AsyncOperation` 第一版不做租约和心跳；多实例部署出现后再加。
- Asset 文件存储（OPT-11b）等基准数据出来后再决定。
- 不预先加索引，以 OPT-17 的查询计划为准。

## 9. 与草稿的主要差异

| 草稿中的内容 | 定稿 | 原因 |
| --- | --- | --- |
| 评估方案中 OPT-01–OPT-08 标为 P0 或 P0/P1 | P0 只保留日志泄露；其余按第 4 节重新定级 | 决策 2 |
| 评估方案 Batch A 包含 OPT-02 | OPT-02 移到 Batch F，只有 D1a 在满足条件时提前；Batch A 改为“数据不丢” | 决策 1 |
| OPT-11 一步完成 ZIP v3 和 Asset 迁移 | 拆为 11a（ZIP v3，不依赖 Asset）和 11b（视基准） | 两者风险等级不同 |
| OPT-10 包含租约和心跳 | 第一版不做 | 单实例部署不需要 |
| OPT-12 只改知识点层 | 增加 12b 逐题记忆模型，灰度上线 | 决策 4 |
| OPT-13 直接改用前端 Canvas | 先验证 `sharp-wasm32` | 决策 5，避免两份裁剪逻辑 |
| 两份草稿都没有 AI 评测、儿童隐私、护栏、每日快照 | 新增 OPT-19–OPT-22 | 扩展设计 E1、E2、E5、E6 |
| 评估方案建议归档为 `doc/ARCHITECTURE_OPTIMIZATION_PLAN.md` | `doc/design/optimization-roadmap.md` 与英文版 | 决策 6 |
| Openclaw “认证静默降级” | 改为“缺少 `isActive` 检查、限流和唯一匹配” | 对照源码，未配置 Key 时会退回密码校验 |
