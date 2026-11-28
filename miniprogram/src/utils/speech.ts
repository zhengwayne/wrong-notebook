/**
 * 单词发音：用学迹后端的云端语音合成（POST /api/tts → GET /api/tts/:id，需要登录），
 * 下载到临时文件再播放；同一个词本次打开内只合成一次。专注模式下也允许。
 */
import { API_BASE_URL } from '../config';
import { buildHeaders, request } from './request';

const cache = new Map<string, string>();
let audio: WechatMiniprogram.InnerAudioContext | null = null;

function player(): WechatMiniprogram.InnerAudioContext {
  if (!audio) {
    audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
    audio.obeyMuteSwitch = false;
  }
  return audio;
}

async function speechFile(text: string, language: 'en' | 'zh'): Promise<string> {
  const cacheKey = `${language}:${text}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const res = await request<{ id: string; version?: string | number }>('/api/tts', {
    method: 'POST',
    data: { text, language },
  });
  const url = `${API_BASE_URL}/api/tts/${res.id}${res.version !== undefined ? `?v=${encodeURIComponent(String(res.version))}` : ''}`;
  const file = await new Promise<string>((resolve, reject) => {
    wx.downloadFile({
      url,
      header: buildHeaders(),
      success: (r) => (r.statusCode === 200 ? resolve(r.tempFilePath) : reject(new Error(`发音下载失败（${r.statusCode}）`))),
      fail: reject,
    });
  });
  cache.set(cacheKey, file);
  return file;
}

/** 朗读；失败时返回 false（由页面决定是否提示） */
export async function speak(text: string, language: 'en' | 'zh' = 'en'): Promise<boolean> {
  try {
    const file = await speechFile(text, language);
    const ctx = player();
    ctx.stop();
    ctx.src = file;
    ctx.play();
    return true;
  } catch {
    return false;
  }
}

export function stopSpeaking(): void {
  if (audio) audio.stop();
}
