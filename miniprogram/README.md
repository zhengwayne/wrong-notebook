# 学迹 · 微信小程序

原生微信小程序 + TypeScript，不引入运行时框架；后端复用学迹网页端的 `/api` 接口，新增 `/api/mp/*` 负责微信登录。

## 功能范围

| 已实现 | 说明 |
| --- | --- |
| 微信一键登录 | `wx.login` 换 openid，第一次用自动建一个只用微信登录的账号，不需要邮箱密码；可选在「我的」里关联网页端已有账号；可退出 |
| 首页 | 首次登录选身份（家长 / 学生 / 老师），切换孩子，今日待复习数量 |
| 拍照 / 相册录错题（多图） | `wx.chooseMedia` 一次最多 9 张（拍照或相册，可增删、长按调整顺序）→ 大于 1.5MB 先 `wx.compressImage` → **逐张** `wx.uploadFile` 上传 `/api/mp/analyze`（同时 2 张）→ 认好一张先显示一张 → 核对、勾选、改题目 → 保存到错题本（每题存它所在那张照片）。各学科通用，没选错题本时按识别出的学科归类 |
| 跨页题合并 | 两张缩略图之间的圆钮把相邻照片连成一组（最多 3 张），一组作为同一道题的几页**一起**识别（只计 1 次 AI 用量），保存时原图是服务端拼好的一张，包含全部几页。识别结果里 AI 会判断每组开头是否接着上一页、结尾是否没写完；相邻两组可能跨页时圆钮变橙色，点一下就连起来重新识别、替换分开的结果；再点一下拆开，恢复之前分开的结果 |
| 错题本 | 按错题本、掌握情况、时间筛选，搜索，分页，详情（原图、答案、解析、错因）；学科栏末尾「+」新建错题本，学段（小学 / 初中 / 高中）和学科与网页端相同（`src/utils/subjects.ts`，`tests/subjects.test.ts` 比对网页端 `notebook-scope.ts`）。拍题默认「自动按学科归类」，AI 认出哪科就放进哪科的错题本，没有就自动新建 |
| 复习 | 今日到期列表，逐题复习：自评做对 / 做错 / 不会，或「举一反三」出同类题并记录结果 |
| 家长查看 | 近 7 天练习、薄弱知识点、今日学习任务、最近一份试卷，扫码导入老师的批改反馈 |
| 孩子专注做题模式 | 小程序里可第一次设置家长 PIN；锁定给某个孩子后只能做题和复习；每个标签页顶部都有锁条，点「解锁」弹出数字键盘输家长 PIN（与网页端同一接口、同样的 5 次错误锁 15 分钟；网络失败可重试） |
| 我的 | 改名字、添加孩子、专注模式、关联网页账号（可选）、隐私指引、退出 |

第一期**不做**、继续在网页端使用：老师批改与文件夹 / PDF 批量导入、试卷整卷订正、打印与导出、统计报表、设置（含修改 / 重置家长 PIN）、管理员后台、英文界面。小程序没有 KaTeX：`utils/latex.ts` 把 LaTeX / mhchem 转成 Unicode 文本（分式、根式、上下标、希腊字母、几何记号、矢量（手机字体没有组合箭头，写成「向量F」）、单位、化学式、离子电荷、反应箭头与条件、气体 / 沉淀符号、HTML 上下标；SMILES 结构式只标注不画图），各学科通用；矩阵、多行推导按行显示，完整排版请在网页端查看。

## 目录

```
miniprogram/
├── project.config.json   # 开发者工具项目配置（appid 在这里）
├── src/                  # 小程序根目录（miniprogramRoot）
│   ├── config.ts         # API_BASE_URL
│   ├── app.json / app.ts / app.wxss
│   ├── utils/            # 请求封装、登录态、文本转换
│   └── pages/            # login home capture notebook item review parent me
│   └── assets/           # 图标（SVG 按需生成）与标签栏 PNG
├── icons/                # 图标源文件（Lucide，ISC 许可），不打包
└── scripts/              # check.mjs 静态检查、build-icons.mjs、build-tabbar.py
```

## 界面

- 薰衣草紫纯色（`#6B5CA5`），不用渐变；字少、图标优先。正文 30rpx，可点区域不低于 88rpx，底部按钮避开安全区。
- 图标来自 [Lucide](https://lucide.dev)（ISC 许可，见 `icons/lucide/LICENSE`）。页面里直接写 `/assets/icons/<名称>-<颜色>.svg`，`npm run build` 会按需生成，只打包用到的图标（目前约 36KB）。颜色代号见 `scripts/build-icons.mjs`。
- 标签栏图标是 81×81 PNG（`scripts/build-tabbar.py` 生成，已提交）。
- AI 识别要 30–90 秒：拍题页显示分步提示、已完成张数、已用秒数和总进度条，缩略图上显示每张的排队 / 识别中 / 题数 / 失败。
- 多图识别每张一个请求，单个请求只有一张压缩后的图（远小于服务端 20MB 和常见 nginx `client_max_body_size`），AI 超时只影响那一张。每个请求带 `x-request-id`：上传超时或网关 502/504 断开时，按编号轮询 `GET /api/requests/:id`（Bearer 鉴权，结果保留 15 分钟）取回结果；真正失败的那张在缩略图上点「重试」或点「重试 N 张」。
- 跨页的一组用 `wx.request` 发 JSON（`{ images: base64[] }`，`wx.uploadFile` 一次只能传一个文件）：每张大于 400KB 先压到宽 1600、质量 75，整组 base64 不超过 15MB（服务端请求体上限 21MB）；超时放宽到 180 秒，同样带 `x-request-id` 可轮询取回。网页端 `/api/analyze` 也接受 `additionalImages`，但网页批量导入界面仍按单张识别。
- 暂不适配深色模式。

## 本地开发

```bash
cd miniprogram
npm install --registry=https://registry.npmjs.org
npm run build      # tsc 类型检查 + 静态检查
```

当前配置：AppID `wx0f5bf175e2aae881`（企业主体），接口地址 `https://xueji.jjool.com`（与网页端同一域名）。

微信开发者工具：「导入项目」选择仓库里的 `miniprogram/` 目录（不是仓库根目录），AppID 会自动读取 `project.config.json`。TypeScript 由开发者工具内置的 `typescript` 编译插件编译，无需额外构建。联调其他服务器时可在「详情 → 本地设置」勾选「不校验合法域名」并临时修改 `src/config.ts`，提交前改回。

## 服务端配置

服务器环境变量（不要写进代码或提交）：

```
WECHAT_MP_APPID=小程序 AppID
WECHAT_MP_APPSECRET=小程序 AppSecret
# 可选，默认 30 天
WECHAT_MP_SESSION_TTL_DAYS=30
```

两项都留空时 `/api/mp/login` 返回 503，网页端不受影响。数据库迁移 `20261125220000_add_wechat_miniprogram_auth` 只新增 `WechatBinding`、`MiniProgramSession` 两张表，不改已有数据。

### 账号规则

- 未绑定的微信第一次登录自动建号（不受网页端 `ALLOW_REGISTRATION` 影响）。要关闭时设 `WECHAT_MP_AUTO_SIGNUP=false`，此时没绑定过的微信会看到「暂未开放微信注册」。
- 自动建的账号用占位邮箱 `wx_<摘要>@wechat.local`（由 AppID + openid 确定，唯一索引保证同一微信并发登录只建一个账号），密码是谁都不知道的随机值。网页登录、Openclaw 账号密码上传、注册、初始化、改邮箱都拒绝 `wechat.local`。仅微信账号也不能通过 `PATCH /api/user` 自己设邮箱或密码（否则等于绕过网页端注册开关），要在网页端用就关联已有网页账号。
- 建号限流：同一 IP 每小时 20 个（需开启 `TRUST_PROXY` 才能取到来源 IP），全站每小时 300 个兜底。
- 「关联网页账号」（可选）：校验网页账号邮箱和密码后，把微信改绑到网页账号，删除原来空的微信账号（AI 用量记录迁过去）。微信账号里已经有错题、孩子、试卷、复习记录等数据时**拒绝关联**，不合并、不丢数据。默认管理员密码的账号须先在网页端改密。
- 只用微信登录的账号不能「解绑微信」（解绑后就进不来了）；管理后台把它显示为「仅微信登录」。

## 发布步骤

1. 小程序已在企业主体下注册（AppID `wx0f5bf175e2aae881`）。服务类目选教育类（如「教育 → 在线教育」或「教育信息服务」），按平台要求提交资质，以后台实际可选为准。
2. 域名 `xueji.jjool.com` 已备案并提供 HTTPS（证书有效、TLS 1.2 及以上）。微信只允许 HTTPS 合法域名，不能用 IP，也不能用 HTTP。
3. 小程序后台「开发管理 → 开发设置 → 服务器域名」：把 `https://xueji.jjool.com` 加入 **request 合法域名**、**uploadFile 合法域名**、**downloadFile 合法域名**。
4. 服务器配置上面的环境变量并部署包含本迁移的版本（AppSecret 只放服务器上 root 可读的环境文件）。
5. `project.config.json` 的 `appid` 与 `src/config.ts` 的 `API_BASE_URL` 已是正式值，换环境时再改。
6. 小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」填写：微信 openid（登录）、相册 / 摄像头（拍题）、关联网页账号时填写的邮箱（可选）等用途；本小程序会调用 `wx.chooseMedia`、`wx.scanCode`、`wx.login`。登录页和「我的」页里的《用户隐私保护指引》链接打开的就是这里配置的内容。
7. 开发者工具「上传」→ 后台提交审核 → 发布。

## 接口约定

- `POST /api/mp/login {code}` → `{ status: 'ok', created, token, user }`；`POST /api/mp/bind {email, password}`（需登录）关联网页账号；`POST /api/mp/profile {name}` 改名字。
- 登录后所有请求带 `Authorization: Bearer xjmp_...`。服务端只保存令牌的 SHA-256 摘要；改密、禁用账号、解绑都会让令牌立即失效。
- 孩子专注锁沿用网页端的签名 Cookie `__wn_kid_lock`：小程序从响应 `Set-Cookie` 中取出，后续请求放进 `Cookie` 请求头。专注模式下 `/api/learners`、`/api/notebooks` 被网关拒绝，页面不调用它们（孩子名字改读 `GET /api/parent/kid-mode`）；会话显示已不在专注模式时自动清掉本地残留的锁，重启不会卡住。
- `wx.request` 不支持 `PATCH`，需要 PATCH 的接口（学习路径步骤）第一期未接入。
