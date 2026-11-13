import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
    return {
        id: '/',
        name: '智能错题本',
        short_name: '错题本',
        description: 'AI 驱动的智能错题管理系统，帮助学生高效整理、分析和复习错题',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#fbf7f2',
        // Web Manifest 规范只允许单一 theme_color；安装启动画面使用浅色主色，运行时由 ThemeProvider 按浅/深色同步 meta theme-color
        theme_color: '#a93800',
        // 手机竖屏、平板横竖屏都可使用，方向交给系统
        orientation: 'any',
        categories: ['education', 'productivity'],
        icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
    }
}
