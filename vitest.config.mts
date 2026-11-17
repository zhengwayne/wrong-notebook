import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const DOM_UNIT_TESTS = [
    'src/__tests__/unit/cloud-speech.test.ts',
    'src/__tests__/unit/frontend-logger.test.ts',
    'src/__tests__/unit/image-utils.test.ts',
    'src/__tests__/unit/parent-paper-annotate-and-summary.test.ts',
    'src/__tests__/unit/smiles-render.test.ts',
    'src/__tests__/unit/speak-text.test.ts',
    'src/__tests__/unit/svg-animation.test.ts',
]

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        setupFiles: ['./src/__tests__/setup.ts'],
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
        projects: [
            {
                extends: true,
                test: {
                    name: 'dom',
                    environment: 'jsdom',
                    include: ['src/__tests__/**/*.test.tsx', ...DOM_UNIT_TESTS],
                    exclude: ['node_modules', '.next', 'dist'],
                },
            },
            {
                extends: true,
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['src/__tests__/**/*.test.ts'],
                    exclude: ['node_modules', '.next', 'dist', ...DOM_UNIT_TESTS],
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'json-summary', 'html'],
            include: ['src/lib/**/*.ts', 'src/app/api/**/*.ts'],
            exclude: ['src/__tests__/**', 'node_modules/**'],
            // 略低于当前实测覆盖率，防止覆盖率下降；补充测试后可逐步提高
            thresholds: {
                statements: 80,
                branches: 70,
                functions: 82,
                lines: 82,
            },
        },
    },
})
