/**
 * 发布前必须修改：
 * - API_BASE_URL：已备案的 HTTPS 域名（不带结尾斜杠），并在小程序后台
 *   「开发管理 → 开发设置 → 服务器域名」把它加入 request 合法域名、uploadFile 合法域名和 downloadFile 合法域名。
 * - AppID 写在 project.config.json 的 appid 字段（当前 touristappid 只能在开发者工具里预览，不能真机调试或上传）。
 * AppSecret 只能配置在服务器环境变量 WECHAT_MP_APPSECRET，绝不能写进小程序代码。
 */
export const API_BASE_URL = 'https://xueji.example.com';

/** 小程序展示用名称 */
export const APP_NAME = '学迹';
