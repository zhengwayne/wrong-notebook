"use client";

import { compressImage } from "@/lib/image-utils";

/** 答卷照片压缩：长边 1600px、单张约 0.8MB，兼顾字迹清晰度与上传速度 */
export function compressPaperImages(files: File[]): Promise<string[]> {
    return Promise.all(files.map((file) => compressImage(file, 0.8, 1600, 0.82)));
}

/** 把按顺序拍好的照片按每份页数分组；最后不足一份的照片单独成组 */
export function groupPages<T>(pages: T[], pagesPerPaper: number): T[][] {
    const size = Math.max(1, Math.floor(pagesPerPaper));
    const groups: T[][] = [];
    for (let i = 0; i < pages.length; i += size) groups.push(pages.slice(i, i + size));
    return groups;
}
