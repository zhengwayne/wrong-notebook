/**
 * Microsoft Edge 在线神经网络语音（免费、无需 API Key）。
 *
 * 选用 node-edge-tts@1.2.12（MIT）：与本仓库 MIT 协议兼容，已处理 2024–2025 年起要求的
 * Sec-MS-GEC，并在 2026-10 握手变更后于 1.2.12（2026-10-26）支持 v2 令牌。
 * 未选用 msedge-tts：虽然同为 MIT 且维护活跃，但其 preinstall 只允许 pnpm，会破坏本仓库的 npm 安装。
 * 未选用 edge-tts-universal（AGPL-3.0）与 Python rany2/edge-tts（主要为 LGPL-3.0），避免协议冲突，也不复制其源码。
 *
 * 该接口是非官方的 Edge 朗读通道，微软可能随时调整；需要能访问外网。
 */
import { EdgeTTS } from "node-edge-tts";
import type { EncodedMp3Audio } from "./mp3";

/** 单段送入 Edge 的建议上限，超过则按句子切开再拼接 MP3 */
export const EDGE_CHUNK_LIMIT = 1800;
const MP3_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const CHUNK_TIMEOUT_MS = 45_000;

export function formatEdgeRate(rate: number | undefined): string {
    const value = rate == null || !Number.isFinite(rate) ? 1 : Math.min(1.5, Math.max(0.75, rate));
    const percent = Math.round((value - 1) * 100);
    if (percent === 0) return "+0%";
    return `${percent > 0 ? "+" : ""}${percent}%`;
}

export function formatEdgePitch(pitch: string | number | undefined): string {
    if (pitch == null || pitch === "") return "default";
    if (typeof pitch === "number" && Number.isFinite(pitch)) {
        const hz = Math.round(pitch);
        return `${hz >= 0 ? "+" : ""}${hz}Hz`;
    }
    return String(pitch);
}

export function languageFromVoice(voice: string): string {
    const match = voice.match(/^([a-z]{2}-[A-Z]{2})/);
    return match?.[1] ?? "zh-CN";
}

/** 按句号、问号等在长度上限内切开，避免一次请求过长被服务拒绝 */
export function splitTtsChunks(text: string, limit = EDGE_CHUNK_LIMIT): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (trimmed.length <= limit) return [trimmed];
    const chunks: string[] = [];
    let remaining = trimmed;
    const markers = ["\n", "。", "！", "？", "；", ". ", "! ", "? ", "，", ", "];
    while (remaining.length > limit) {
        const slice = remaining.slice(0, limit);
        let breakAt = -1;
        for (const marker of markers) {
            breakAt = Math.max(breakAt, slice.lastIndexOf(marker));
        }
        const end = breakAt >= Math.floor(limit * 0.4) ? breakAt + 1 : limit;
        const chunk = remaining.slice(0, end).trim();
        if (chunk) chunks.push(chunk);
        remaining = remaining.slice(end).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

export interface EdgeSynthesizeOptions {
    voice: string;
    rate?: number;
    pitch?: string | number;
}

async function synthesizeChunk(text: string, options: EdgeSynthesizeOptions): Promise<Buffer> {
    const tts = new EdgeTTS({
        voice: options.voice,
        lang: languageFromVoice(options.voice),
        outputFormat: MP3_FORMAT,
        rate: formatEdgeRate(options.rate),
        pitch: formatEdgePitch(options.pitch),
        timeout: CHUNK_TIMEOUT_MS,
    });
    const parts: Buffer[] = [];
    for await (const chunk of tts.streamAudio(text)) {
        if (Buffer.isBuffer(chunk)) parts.push(chunk);
    }
    if (!parts.length) {
        throw new Error("Edge TTS returned no audio");
    }
    return Buffer.concat(parts);
}

/** 调用 Edge 在线语音，返回 24 kHz 48 kbps 单声道 MP3。
 *  当前通道不再提供 raw/riff PCM（会以 WebSocket 1007 关闭），因此跳过响度归一化后重编码。
 */
export async function synthesizeEdge(text: string, options: EdgeSynthesizeOptions): Promise<EncodedMp3Audio> {
    const chunks = splitTtsChunks(text);
    if (!chunks.length) {
        throw new Error("Edge TTS received empty text");
    }
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
        buffers.push(await synthesizeChunk(chunk, options));
    }
    const pcm = Buffer.concat(buffers);
    if (pcm.length < 2) {
        throw new Error("Edge TTS returned empty audio");
    }
    return { encoded: "mp3", data: pcm };
}
