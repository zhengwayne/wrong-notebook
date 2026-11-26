/**
 * 正式环境：与学迹网页端同一域名（已备案、HTTPS）。
 * 需在小程序后台「开发管理 → 开发设置 → 服务器域名」把它加入 request、uploadFile、downloadFile 合法域名。
 * AppID 写在 project.config.json 的 appid 字段；AppSecret 只配置在服务器环境变量 WECHAT_MP_APPSECRET，绝不能写进小程序代码。
 * 本地联调其他服务器时临时改这里，并在开发者工具勾选「不校验合法域名」，提交前改回。
 */
export const API_BASE_URL = 'https://xueji.jjool.com';

/** 小程序展示用名称 */
export const APP_NAME = '学迹';

/**
 * 审核安全模式：小程序只做题目识别与对错标记，不展示任何合成内容。
 * 关闭时才显示单词插图、数学插图与徽章图片，并启用单词发音（语音合成）。这些都属于深度合成范畴，
 * 打开前需要先在小程序后台补充对应类目，并按要求标注。
 */
export const SHOW_SYNTH_MEDIA = false;
