/**
 * Edge 在线语音：语速格式、按句切分，以及（模拟）合成 MP3
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type StreamFn = (text: string) => AsyncGenerator<Buffer>;
const stream = vi.hoisted(() => {
    const empty: StreamFn = async function* () { yield Buffer.alloc(0); };
    return { impl: empty };
});

vi.mock('node-edge-tts', () => ({
    EdgeTTS: class {
        opts: unknown;
        constructor(opts: unknown) { this.opts = opts; }
        streamAudio(text: string) { return stream.impl(text); }
    },
}));

import { formatEdgePitch, formatEdgeRate, languageFromVoice, splitTtsChunks, synthesizeEdge } from '@/lib/tts/edge-tts';
import { resolveTtsSettings } from '@/lib/tts/providers';

describe('Edge 语音辅助函数', () => {
    it('把 0.75–1.5 的语速写成 SSML 百分比', () => {
        expect(formatEdgeRate(1)).toBe('+0%');
        expect(formatEdgeRate(1.25)).toBe('+25%');
        expect(formatEdgeRate(0.75)).toBe('-25%');
        expect(formatEdgePitch(0)).toBe('+0Hz');
        expect(formatEdgePitch('+10Hz')).toBe('+10Hz');
        expect(languageFromVoice('zh-CN-XiaoxiaoNeural')).toBe('zh-CN');
        expect(languageFromVoice('en-US-AriaNeural')).toBe('en-US');
    });

    it('按句号把长文本切开，不在过早的位置断开', () => {
        const text = `${'甲。'.repeat(50)}${'乙。'.repeat(50)}${'丙。'.repeat(50)}`;
        const chunks = splitTtsChunks(text, 40);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
        expect(chunks.join('')).toBe(text);
        expect(splitTtsChunks('短句', 40)).toEqual(['短句']);
    });
});

describe('Edge 语音合成（模拟网络）', () => {
    beforeEach(() => {
        stream.impl = async function* (text: string) {
            const pcm = Buffer.alloc(4);
            pcm.writeInt16LE(16384, 0);
            pcm.writeInt16LE(-16384, 2);
            yield pcm;
            void text;
        };
    });

    it('无需 API Key，返回 MP3', async () => {
        const settings = resolveTtsSettings('edge', { voice: 'zh-CN-XiaoxiaoNeural' }, undefined);
        expect(settings.apiKey).toBe('');
        expect(settings.voice).toBe('zh-CN-XiaoxiaoNeural');
        expect(settings.englishVoice).toBe('en-US-AriaNeural');
        const audio = await synthesizeEdge('你好，晓晓。', { voice: settings.voice, rate: 1 });
        expect(audio.encoded).toBe('mp3');
        expect(audio.data.length).toBe(4);
    });

    it('长文本会按段拼接 MP3', async () => {
        const calls: string[] = [];
        stream.impl = async function* (text: string) {
            calls.push(text);
            const pcm = Buffer.alloc(2);
            pcm.writeInt16LE(16384, 0);
            yield pcm;
        };
        const long = `${'这是一句完整的话。'.repeat(400)}`;
        const audio = await synthesizeEdge(long, { voice: 'zh-CN-XiaoxiaoNeural', rate: 1 });
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.join('')).toBe(long);
        expect(audio.encoded).toBe('mp3');
        expect(audio.data.length).toBe(calls.length * 2);
    });
});
