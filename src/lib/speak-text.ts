/**
 * 统一的朗读入口：优先走服务端 TTS（Edge 或其他云端语音），失败时回退到浏览器 Web Speech，保证能出声。
 */
"use client";

import { getSpeechAudio, getSpeechMode, requestSpeech, unlockSpeechAudio } from "@/lib/cloud-speech";
import { detectSpeechLanguage, toSpeakableText } from "@/lib/speakable-text";

export interface SpeakOptions {
    language?: "zh" | "en";
    /** 为 false 时不去掉 Markdown/LaTeX（动画讲解稿已是口语） */
    speakable?: boolean;
    rate?: number;
}

export interface SpeakHandle {
    stop: () => void;
    done: Promise<void>;
}

let active: SpeakHandle | null = null;

function getSynth(): SpeechSynthesis | null {
    return typeof window !== "undefined" ? window.speechSynthesis ?? null : null;
}

function pickLocalVoice(language: "zh" | "en"): SpeechSynthesisVoice | undefined {
    const voices = getSynth()?.getVoices() ?? [];
    const prefix = language === "zh" ? "zh" : "en";
    return voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix))
        ?? voices.find((voice) => voice.lang.toLowerCase().startsWith(language));
}

function stopLocal() {
    getSynth()?.cancel();
}

function stopCloud() {
    const audio = getSpeechAudio();
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
}

/** 停止当前正在进行的朗读 */
export function stopSpeaking() {
    active?.stop();
    active = null;
    stopLocal();
    stopCloud();
}

function speakWithBrowser(text: string, language: "zh" | "en", rate: number): SpeakHandle {
    const synth = getSynth();
    if (!synth) {
        return { stop() {}, done: Promise.resolve() };
    }
    let stopped = false;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language === "en" ? "en-US" : "zh-CN";
    utterance.rate = rate;
    const voice = pickLocalVoice(language);
    if (voice) utterance.voice = voice;
    const done = new Promise<void>((resolve) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
    });
    synth.speak(utterance);
    return {
        stop() {
            if (stopped) return;
            stopped = true;
            synth.cancel();
        },
        done,
    };
}

/**
 * 朗读一段文字。Edge 或其它云端语音失败时自动改用浏览器语音。
 * 同一时间只播放一段，再次调用会先停掉上一段。
 */
export async function speakText(raw: string, options: SpeakOptions = {}): Promise<SpeakHandle> {
    const language = options.language ?? detectSpeechLanguage(raw);
    const text = options.speakable === false ? raw.trim() : toSpeakableText(raw, language);
    const rate = options.rate && Number.isFinite(options.rate) ? Math.min(1.5, Math.max(0.75, options.rate)) : 1;
    if (!text) return { stop() {}, done: Promise.resolve() };

    stopSpeaking();
    unlockSpeechAudio();

    const fallback = () => speakWithBrowser(text, language, rate);

    let handle: SpeakHandle;
    const mode = await getSpeechMode();
    if (mode !== "cloud") {
        handle = fallback();
    } else {
        try {
            const url = await requestSpeech(text, language);
            const audio = getSpeechAudio();
            if (!audio) {
                handle = fallback();
            } else {
                let stopped = false;
                let settled = false;
                const done = new Promise<void>((resolve) => {
                    const finish = () => {
                        if (settled) return;
                        settled = true;
                        resolve();
                    };
                    audio.onended = finish;
                    audio.onerror = () => {
                        if (stopped || settled) {
                            finish();
                            return;
                        }
                        const local = fallback();
                        handle.stop = local.stop;
                        handle.done = local.done;
                        void local.done.then(finish);
                    };
                    audio.src = url;
                    audio.playbackRate = rate;
                    audio.play().catch(() => {
                        if (stopped) {
                            finish();
                            return;
                        }
                        const local = fallback();
                        handle.stop = local.stop;
                        handle.done = local.done;
                        void local.done.then(finish);
                    });
                });
                handle = {
                    stop() {
                        if (stopped) return;
                        stopped = true;
                        audio.pause();
                    },
                    done,
                };
            }
        } catch {
            handle = fallback();
        }
    }

    const wrapped: SpeakHandle = {
        stop() {
            handle.stop();
            if (active === wrapped) active = null;
        },
        done: handle.done.finally(() => {
            if (active === wrapped) active = null;
        }),
    };
    active = wrapped;
    return wrapped;
}
