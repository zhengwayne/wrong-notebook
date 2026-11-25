# 学迹 · 微信小程序（第一期）

原生微信小程序 + TypeScript，不引入运行时框架；后端复用学迹网页端的 `/api` 接口，新增 `/api/mp/*` 负责微信登录。

## 功能范围

| 已实现 | 说明 |
| --- | --- |
| 微信登录 / 账号绑定 | `wx.login` 换 openid；首次用网页端的邮箱和密码绑定一次，之后一键登录；可退出、解绑 |
| 首页 | 首次登录选身份（家长 / 老师 / 自学），切换孩子，今日待复习数量 |
| 拍照 / 相册录错题 | `wx.chooseMedia` → `wx.uploadFile` 上传 `/api/mp/analyze` → 核对、勾选、改题目 → 保存到错题本 |
| 错题本 | 按错题本、掌握情况、时间筛选，搜索，分页，详情（原图、答案、解析、错因） |
| 复习 | 今日到期列表，逐题复习：自评做对 / 做错 / 不会，或「举一反三」出同类题并记录结果 |
| 家长查看 | 近 7 天练习、薄弱知识点、今日学习任务、最近一份试卷，扫码导入老师的批改反馈 |
| 孩子专注做题模式 | 家长锁定给某个孩子后只能做题和复习，输入 PIN 解锁（规则与网页端完全相同） |

第一期**不做**、继续在网页端使用：老师批改与文件夹 / PDF 批量导入、试卷整卷订正、打印与导出、统计报表、设置（含家长 PIN 设置）、管理员后台、英文界面。公式目前按纯文本显示（`utils/text.ts`），复杂公式请在网页端查看。

## 目录

```
miniprogram/
├── project.config.json   # 开发者工具项目配置（appid 在这里）
├── src/                  # 小程序根目录（miniprogramRoot）
│   ├── config.ts         # API_BASE_URL
│   ├── app.json / app.ts / app.wxss
│   ├── utils/            # 请求封装、登录态、文本转换
│   └── pages/            # login home capture notebook item review parent me
└── scripts/check.mjs     # 静态检查
```

## 本地开发

```bash
cd miniprogram
npm install --registry=https://registry.npmjs.org
npm run build      # tsc 类型检查 + 静态检查
```

微信开发者工具：「导入项目」选择仓库里的 `miniprogram/` 目录（不是仓库根目录）。TypeScript 由开发者工具内置的 `typescript` 编译插件编译，无需额外构建。本地调试时可在开发者工具「详情 → 本地设置」勾选「不校验合法域名」，并把 `src/config.ts` 指向测试服务器。

## 服务端配置

服务器环境变量（不要写进代码或提交）：

```
WECHAT_MP_APPID=小程序 AppID
WECHAT_MP_APPSECRET=小程序 AppSecret
# 可选，默认 30 天
WECHAT_MP_SESSION_TTL_DAYS=30
```

两项都留空时 `/api/mp/login` 返回 503，网页端不受影响。数据库迁移 `20261125220000_add_wechat_miniprogram_auth` 只新增 `WechatBinding`、`MiniProgramSession` 两张表，不改已有数据。

## 发布步骤

1. 在微信公众平台注册小程序，拿到 AppID 和 AppSecret。教育类服务需要选对服务类目（如「教育 → 在线教育」或「教育信息服务」），按平台要求提交资质；个人主体能开放的教育类目有限，以后台实际可选为准。
2. 准备一个**已完成 ICP 备案的域名**并配置 HTTPS（证书有效、TLS 1.2 及以上）。微信只允许 HTTPS 合法域名，不能用 IP，也不能用 HTTP。
3. 小程序后台「开发管理 → 开发设置 → 服务器域名」：把该域名加入 **request 合法域名**、**uploadFile 合法域名**、**downloadFile 合法域名**。
4. 服务器配置上面的环境变量并部署包含本迁移的版本。
5. 修改 `project.config.json` 的 `appid`、`src/config.ts` 的 `API_BASE_URL`。
6. 小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」填写：收集账号（邮箱）、相册 / 摄像头（拍题）、微信 openid（登录）等用途；本小程序会调用 `wx.chooseMedia`、`wx.scanCode`、`wx.login`。登录页和「我的」页里的《用户隐私保护指引》链接打开的就是这里配置的内容。
7. 开发者工具「上传」→ 后台提交审核 → 发布。

## 接口约定

- 登录后所有请求带 `Authorization: Bearer xjmp_...`。服务端只保存令牌的 SHA-256 摘要；改密、禁用账号、解绑都会让令牌立即失效。
- 孩子专注锁沿用网页端的签名 Cookie `__wn_kid_lock`：小程序从响应 `Set-Cookie` 中取出，后续请求放进 `Cookie` 请求头。
- `wx.request` 不支持 `PATCH`，需要 PATCH 的接口（学习路径步骤）第一期未接入。
