/**
 * 仅用微信登录的账号（小程序自动注册）：
 * - 邮箱字段是必填且唯一的，这类账号写入不可路由的占位邮箱 `wx_<摘要>@wechat.local`；
 * - `.local` 是保留的本地域名，不会投递任何邮件；系统也没有任何发信或找回密码功能；
 * - 网页登录、Openclaw 账号密码上传、注册、初始化、改邮箱都拒绝这个域名，占位邮箱永远不能用于网页登录。
 * 这个文件不依赖 Node 内置模块，前端组件也可以引用。
 */
export const WECHAT_PLACEHOLDER_EMAIL_DOMAIN = 'wechat.local';

export function isWechatPlaceholderEmail(email: string | null | undefined): boolean {
    if (typeof email !== 'string') return false;
    return email.trim().toLowerCase().endsWith(`@${WECHAT_PLACEHOLDER_EMAIL_DOMAIN}`);
}

/** 管理后台等处展示用：占位邮箱显示为“仅微信登录” */
export function displayAccountEmail(email: string | null | undefined, wechatOnlyLabel = '仅微信登录'): string {
    if (isWechatPlaceholderEmail(email)) return wechatOnlyLabel;
    return email ?? '';
}
