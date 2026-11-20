import type { zh } from "./zh";

export type Language = "zh" | "en";

type WidenStrings<T> = T extends string
    ? string
    : T extends object
        ? { [K in keyof T]: WidenStrings<T[K]> }
        : T;

/** 界面文案结构：由中文基准结构递归宽化字符串，供英文包按需异步校验 */
export type Translations = WidenStrings<typeof zh>;
