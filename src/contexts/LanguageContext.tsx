"use client";

import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import {
    getLoadedEnglishDictionary,
    loadEnglishDictionary,
    subscribeEnglishDictionary,
} from '@/lib/translations/loader';
import type { Language, Translations } from '@/lib/translations/types';
import { zh } from '@/lib/translations/zh';

interface LanguageContextType {
    language: Language;
    setLanguage: (lang: Language) => void;
    t: Translations;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const STORAGE_KEY = 'app-language';
const DEFAULT_LANGUAGE: Language = 'zh';

// 界面语言保存在 localStorage，作为外部状态订阅；本页切换时通知订阅者，其他标签页切换时由 storage 事件通知
const languageListeners = new Set<() => void>();

function subscribeLanguage(listener: () => void) {
    languageListeners.add(listener);
    window.addEventListener('storage', listener);
    return () => {
        languageListeners.delete(listener);
        window.removeEventListener('storage', listener);
    };
}

function readLanguage(): Language {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'zh' || saved === 'en' ? saved : DEFAULT_LANGUAGE;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
    // 服务端渲染与水合阶段使用默认中文，切换英文时再按需异步加载英文词典
    const language = useSyncExternalStore(subscribeLanguage, readLanguage, () => DEFAULT_LANGUAGE);
    const enDictionary = useSyncExternalStore(subscribeEnglishDictionary, getLoadedEnglishDictionary, () => null);

    useEffect(() => {
        if (typeof document !== 'undefined') {
            document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
        }
        if (language === 'en' && !enDictionary) {
            void loadEnglishDictionary().catch(() => undefined);
        }
    }, [language, enDictionary]);

    const handleSetLanguage = (lang: Language) => {
        localStorage.setItem(STORAGE_KEY, lang);
        if (lang === 'en') {
            void loadEnglishDictionary().catch(() => undefined);
        }
        languageListeners.forEach((listener) => listener());
    };

    const value: LanguageContextType = {
        language,
        setLanguage: handleSetLanguage,
        t: language === 'en' && enDictionary ? enDictionary : zh,
    };

    return (
        <LanguageContext.Provider value={value}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage() {
    const context = useContext(LanguageContext);
    if (context === undefined) {
        throw new Error('useLanguage must be used within a LanguageProvider');
    }
    return context;
}
