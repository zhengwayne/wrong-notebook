import type { Language, Translations } from "./types";
import { zh } from "./zh";

const DEFAULT_EN_DAILY_LIMIT_MESSAGE = "You have used up today's AI allowance. Try again tomorrow or ask an administrator to raise the limit.";

let cachedEn: Translations | null = null;
let loadingEn: Promise<Translations> | null = null;
const enListeners = new Set<() => void>();

export function subscribeEnglishDictionary(listener: () => void): () => void {
    enListeners.add(listener);
    return () => {
        enListeners.delete(listener);
    };
}

export function getLoadedEnglishDictionary(): Translations | null {
    return cachedEn;
}

/** 按需动态加载英文词典并写入缓存后再通知订阅者，防止英文词典静态打入首屏包 */
export function loadEnglishDictionary(): Promise<Translations> {
    if (cachedEn) return Promise.resolve(cachedEn);
    if (!loadingEn) {
        loadingEn = import("./en")
            .then((mod) => {
                cachedEn = mod.en;
                enListeners.forEach((listener) => listener());
                return mod.en;
            })
            .catch((error) => {
                loadingEn = null;
                throw error;
            });
    }
    return loadingEn;
}

export function getLoadedAiDailyLimitMessage(language: Language): string {
    if (language === "en") {
        return cachedEn?.errors.AI_DAILY_LIMIT_EXCEEDED ?? DEFAULT_EN_DAILY_LIMIT_MESSAGE;
    }
    return zh.errors.AI_DAILY_LIMIT_EXCEEDED;
}

/** 仅用于单测重置按需加载的英文词典缓存 */
export function resetEnglishDictionaryCacheForTest(): void {
    cachedEn = null;
    loadingEn = null;
}
