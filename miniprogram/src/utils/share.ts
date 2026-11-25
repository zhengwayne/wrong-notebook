/** 从老师分享的反馈链接（…/share/submission/<token>）或纯令牌里取出令牌 */
export function extractShareToken(raw: string): string | null {
  const text = (raw || '').trim();
  const match = /\/share\/(?:submission\/)?([A-Za-z0-9_-]{20,128})/.exec(text);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{20,128}$/.test(text) ? text : null;
}
