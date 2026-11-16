/**
 * 朗读入口：云端合成失败时回退到浏览器 Web Speech API
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const speech = vi.hoisted(() => ({
    mode: 'cloud' as 'browser' | 'cloud',
    request: vi.fn(),
    audio: null as HTMLAudioElement | null,
}));

vi.mock('@/lib/cloud-speech', () => ({
    getSpeechMode: () => Promise.resolve(speech.mode),
    requestSpeech: (...args: unknown[]) => speech.request(...args),
    unlockSpeechAudio: vi.fn(),
    getSpeechAudio: () => speech.audio,
}));

import { speakText, stopSpeaking } from '@/lib/speak-text';

class FakeUtterance {
    lang = '';
    rate = 1;
    voice: unknown = null;
    onend: ((event?: Event) => void) | null = null;
    onerror: ((event?: Event) => void) | null = null;
    constructor(public text: string) {}
}

function mockSynth() {
    const spoken: FakeUtterance[] = [];
    const synth = {
        speak: vi.fn((utterance: FakeUtterance) => {
            spoken.push(utterance);
            queueMicrotask(() => utterance.onend?.(new Event('end')));
        }),
        cancel: vi.fn(),
        getVoices: () => [{ lang: 'zh-CN', name: 'Tingting' }],
    };
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    return { synth, spoken };
}

beforeEach(() => {
    vi.clearAllMocks();
    speech.mode = 'cloud';
    speech.request.mockReset();
    speech.audio = null;
    stopSpeaking();
});

describe('speakText 回退', () => {
    it('云端合成失败时改用浏览器语音，朗读去掉 LaTeX 后的文本', async () => {
        const { synth, spoken } = mockSynth();
        speech.request.mockRejectedValue(new Error('502'));
        const handle = await speakText('计算 $3 \\times 4$');
        expect(speech.request).toHaveBeenCalled();
        expect(synth.speak).toHaveBeenCalledTimes(1);
        expect(spoken[0].text).toMatch(/乘以/);
        expect(spoken[0].lang).toBe('zh-CN');
        await handle.done;
    });

    it('当前为浏览器语音时不请求服务端', async () => {
        const { synth } = mockSynth();
        speech.mode = 'browser';
        await speakText('你好');
        expect(speech.request).not.toHaveBeenCalled();
        expect(synth.speak).toHaveBeenCalledTimes(1);
    });
});
