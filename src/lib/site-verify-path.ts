/** 站点根目录校验文件的路径形状（proxy 用，不依赖 fs）：/<字母数字_->.txt */
export const SITE_VERIFY_PATH_RE = /^\/([A-Za-z0-9_-]{1,64})\.txt$/;

/** 根路径 /<name>.txt 对应的文件名；不是这种形状返回 null */
export function siteVerifyName(pathname: string): string | null {
    const match = SITE_VERIFY_PATH_RE.exec(pathname);
    return match ? match[1] : null;
}
