# 数据备份与恢复

网页导出默认使用 **v3 流式 ZIP 归档**（`XueJi-backup-*.zip`），适合迁移完整个人或多人学习数据；整站恢复应备份 SQLite 数据库、服务端配置与部署参数。

## 两种备份的范围

| 方式 | 包含内容 | 适用场景 |
| --- | --- | --- |
| 网页 v3 ZIP 备份 | `manifest.json`、错题本、自定义标签、学习者档案（孩子/学生）、错题、练习记录、随机试卷、家长试卷与批改题目、教师班级/花名册/批改结果、变式运行与阶段日志、掌握度与学习路径、AI 溯源、`media/<sha256>` 原图与云端语音（MP3） | 换设备、跨环境个人及多人教学数据迁移 |
| 兼容旧版 JSON（v1/v2） | 错题本、自定义标签、错题、练习记录、随机试卷、变式运行、云端语音与偏好设置；**不包含** `Learner`、家长试卷、教师改卷、掌握度与学习路径 | 仅用于导入历史保留的 `.json` 文件（可通过 `GET /api/export?format=json` 按旧格式导出） |
| 整站文件备份 | 完整 SQLite 数据库、`config/`、部署配置、凭证哈希及 HTTPS 证书 | 灾难恢复、整站迁移、版本升级前回退准备 |

网页导出均**不包含**账户登录密码哈希或服务端 AI 提供商密钥，也不能替代整站文件备份。系统内运行时的 `AiUsage` 与本地迁移审计日志 `LearnerBackfillAudit` 不随网页备份迁移。

## 网页导出与导入（ZIP v3 与兼容边界）

1. 在「设置 → 危险」下的「数据管理」区域点击导出，服务端通过游标分页与流式 ZIP 打包：图片以内容 SHA-256 去重存入 `media/<sha256>`，音频存入 `tts/<id>.mp3`，文本数据写入 `data/*.ndjson`，结尾生成带完整文件摘要与记录计数的 `manifest.json`。
2. 普通用户导入时，归档内主体邮箱必须与当前账户一致；管理员使用 `导出全部 / 导入全部` 可在多账户间映射迁移业务数据。
3. 导入时会校对 `manifest.json` 的格式版本与每个条目的大小及 SHA-256 摘要，并重建新旧 ID 映射关系（包括学习者、变式阶段日志、掌握度与学习路径）。
4. **旧版与遗留数据说明**：
   - 导入 v1/v2 `.json` 文件时接口仍保持兼容，但无法还原学习者档案、家长试卷、教师批改、掌握度快照或学习路径；
   - 遗留的 `ReviewSchedule` 表已不再参与业务读写（复习到期统一由作答历史推算）。v3 导入时会跳过写入该遗留表并返回提示。
5. 重复题目按当前学习者作用域内的题干相似度判重：命中判重时不会覆盖原题，而是在原题的同一学习者作用域下新增一次做错练习快照。
6. **可选口令加密（AES-256-GCM + scrypt）**：
   - 导出前在口令框填写口令，即可通过 `POST /api/export` 流式加密 `data/*.ndjson`、`media/*` 与 `tts/*.mp3`（每个条目独立 12 字节随机 IV，以条目路径作为 GCM 认证关联数据 AAD）；`manifest.json` 仅明文保存算法参数、随机盐值、加密后的 `keyCheck` 校验块及加密条目密文摘要，不保存口令本身；
   - 未设置口令时，界面与响应头（`X-Backup-Unencrypted-Warning: 1`）会提醒文件包含题目原图与学习记录，请勿在未加密状态下上传公共网盘；
   - 口令无法重置或找回，请妥善保管；导入加密包时必须在设置界面填入口令或通过 `passphrase` 表单字段 / `X-Backup-Passphrase` 请求头传入，缺口令或错口令会明确拒收且不会改动当前数据库。

## Docker 整站备份

下例适用于[部署指南](Deployment)中的目录布局。应用默认启用 SQLite **WAL 模式**（配合 `busy_timeout=5000` 和 `foreign_keys=ON`）。停止应用后再归档，可使 SQLite 主库文件、`-wal`/`-shm` 辅助文件及配置保持一致；若希望生成不依赖 `-wal` 的单文件副本，可在停机或无写入时对数据库执行 `PRAGMA wal_checkpoint(TRUNCATE)` 后再备份 `.db` 文件。

如果数据目录挂载在 NAS 的 NFS / CIFS 网络卷上（不支持跨节点共享内存锁），可在环境变量中设置 `SQLITE_JOURNAL_MODE=DELETE` 或 `TRUNCATE`（此时会自动切换为 `synchronous=FULL`）。

## 每日一致性快照与迁移前备份

- **每日自动快照**：服务运行期间默认每天通过 SQLite `VACUUM INTO` 在数据目录的 `backups/` 下生成一份一致性快照（`daily-snapshot-YYYY-MM-DD.db`），默认保留最近 7 份（可通过 `DAILY_SNAPSHOT_RETENTION` 调整）。可在「设置 → 危险」查看最近成功时间，快照失败时首页顶部会出现提醒。已有宿主机卷快照的 Docker 部署可设置 `DAILY_SNAPSHOT_ENABLED=false` 关闭。
- **迁移前自动备份**：安装包（npm / 桌面版 / 飞牛OS）和 Docker 镜像在启动执行 `prisma migrate deploy` 前会自动把当前数据库刷盘检查点后备份到 `backups/pre-migrate-*`（最多保留最近 3 份），迁移失败时停止启动并提示恢复路径。
- **管理员系统初始化**：在「设置 → 危险」最下方点击系统初始化并二次确认输入 `RESET` 后，服务端会等待内存后台任务落盘，随后在单个数据库事务中反序清空全部业务与审计表并清除磁盘 TTS 与恢复缓存，仅保留当前管理员账号与 `isSystem: true` 系统预设知识点树（适合彻底重建或归档前重置）。

在部署目录执行：

```bash
mkdir -p backups
docker compose stop wrong-notebook
backup_file="backups/wrong-notebook-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$backup_file" data config docker-compose.yml .env
docker compose start wrong-notebook
tar -tzf "$backup_file"
```

备份失败时不要继续升级，先处理失败原因并确认服务恢复。使用内置 HTTPS 时，把 `certs/` 也加入归档；有额外部署文件时一并保存。

备份中可能含题目原图、用户资料、密码哈希和 AI 凭据，应限制访问并保存在独立位置。检查归档能够读取，并在隔离环境中验证恢复流程。

## 恢复整站

1. 确认备份时间、来源版本和归档内容；保存当前数据与配置的另一份副本。
2. 停止应用，避免恢复过程中继续写入数据库。
3. 在独立目录解开备份并检查，再恢复 `data/`、`config/` 和所需部署文件。
4. 优先使用与备份匹配的镜像版本，保留正确的挂载路径和 `NEXTAUTH_SECRET`。
5. 启动后检查 `/api/health`，登录核对用户、错题、标签、作答历史和试卷。

不要把旧数据库直接交给不兼容的新旧版本反复切换。需要升级时，在恢复验证完成后单独执行[升级流程](Deployment)。

## 源码运行的备份

默认 SQLite 文件位于 `prisma/dev.db`，实际位置由 `DATABASE_URL` 决定。停止服务后备份实际数据库所在目录、`config/`、`.env` 和版本信息；恢复时使用匹配代码及依赖，再按需要执行正式迁移。

范围依据：[导出实现](https://github.com/margrop/wrong-notebook/blob/main/src/app/api/export/route.ts) · [v3 备份引擎](https://github.com/margrop/wrong-notebook/blob/main/src/lib/backup/export-v3.ts) · [导入实现](https://github.com/margrop/wrong-notebook/blob/main/src/app/api/import/route.ts) · [数据模型](https://github.com/margrop/wrong-notebook/blob/main/prisma/schema.prisma)。
