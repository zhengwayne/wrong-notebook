/**
 * 学英语 / 学数学的题库、词表放在原来的站点（lingo.jjool.com、math.jjool.com），不打进小程序包。
 * 第一次用 wx.downloadFile 下载 JSON，存到本地用户目录；之后先用本地副本，过期（默认 1 天）再后台更新，
 * 下载失败时继续用旧副本。需要把这两个域名加进小程序后台的 downloadFile 合法域名。
 */
const DAY = 24 * 60 * 60 * 1000;
const STAMP_PREFIX = 'xueji.mp.dataAt:';
const memory = new Map<string, unknown>();

function localPath(key: string): string {
  return `${wx.env.USER_DATA_PATH}/xj-data-${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

function readLocal(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: path,
      encoding: 'utf8',
      success: (res) => resolve(String(res.data)),
      fail: reject,
    });
  });
}

function writeLocal(path: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    // 写不进去（空间不足等）不影响本次使用，下次再下
    wx.getFileSystemManager().writeFile({ filePath: path, data: text, encoding: 'utf8', complete: () => resolve() });
  });
}

function download(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      timeout: 60000,
      success: (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败（${res.statusCode}）`));
          return;
        }
        readLocal(res.tempFilePath).then(resolve, reject);
      },
      fail: reject,
    });
  });
}

async function fetchAndStore<T>(key: string, url: string): Promise<T> {
  const text = await download(url);
  const value = JSON.parse(text) as T;
  memory.set(key, value);
  await writeLocal(localPath(key), text);
  wx.setStorageSync(STAMP_PREFIX + key, Date.now());
  return value;
}

/** 读取远端 JSON（带本地缓存） */
export async function loadRemoteJson<T>(key: string, url: string, maxAgeMs = DAY): Promise<T> {
  if (memory.has(key)) return memory.get(key) as T;
  const stamp = Number(wx.getStorageSync(STAMP_PREFIX + key)) || 0;
  let cached: T | null = null;
  if (stamp) {
    try {
      cached = JSON.parse(await readLocal(localPath(key))) as T;
    } catch {
      cached = null;
    }
  }
  if (cached !== null) {
    memory.set(key, cached);
    // 过期了：先用旧的，后台悄悄更新
    if (Date.now() - stamp > maxAgeMs) fetchAndStore<T>(key, url).catch(() => undefined);
    return cached;
  }
  return fetchAndStore<T>(key, url);
}
