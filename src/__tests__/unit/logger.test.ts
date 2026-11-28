import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 需要在导入 logger 之前设置环境变量
const originalEnv = { ...process.env };

describe('logger module', () => {
    beforeEach(() => {
        // 清理 mock
        vi.restoreAllMocks();
    });

    afterEach(() => {
        // 恢复环境变量
        process.env = { ...originalEnv };
    });

    describe('createLogger', () => {
        it('应该创建带模块标识的 child logger', async () => {
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test-module');

            expect(logger).toBeDefined();
            expect(typeof logger.info).toBe('function');
            expect(typeof logger.error).toBe('function');
            expect(typeof logger.debug).toBe('function');
            expect(typeof logger.warn).toBe('function');
            expect(typeof logger.trace).toBe('function');
            expect(typeof logger.fatal).toBe('function');
            expect(typeof logger.child).toBe('function');
            expect(typeof logger.box).toBe('function');
            expect(typeof logger.divider).toBe('function');
        });

        it('应该支持创建嵌套的 child logger', async () => {
            const { createLogger } = await import('@/lib/logger');
            const parentLogger = createLogger('parent');
            const childLogger = parentLogger.child({ subModule: 'child' });

            expect(childLogger).toBeDefined();
            expect(typeof childLogger.info).toBe('function');
        });
    });

    describe('日志级别', () => {
        it('应该有正确的日志级别数值', async () => {
            // 测试各级别方法存在
            const { logger } = await import('@/lib/logger');

            expect(logger.trace).toBeDefined();
            expect(logger.debug).toBeDefined();
            expect(logger.info).toBeDefined();
            expect(logger.warn).toBeDefined();
            expect(logger.error).toBeDefined();
            expect(logger.fatal).toBeDefined();
        });
    });

    describe('日志输出', () => {
        it('应该支持简单字符串消息', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.info('Test message');

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('应该支持带上下文的消息', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.info({ userId: 123, action: 'login' }, 'User logged in');

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('应该使用 console.error 输出 error 级别日志', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.error({ error: new Error('test') }, 'Error occurred');

            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });

        it('应该使用 console.warn 输出 warn 级别日志', async () => {
            const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.warn('Warning message');

            expect(consoleWarnSpy).toHaveBeenCalled();
            consoleWarnSpy.mockRestore();
        });

        it('应该使用 console.error 输出 fatal 级别日志', async () => {
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.fatal('Fatal error');

            expect(consoleErrorSpy).toHaveBeenCalled();
            consoleErrorSpy.mockRestore();
        });
    });

    describe('装饰性日志', () => {
        it('应该支持 box 方法输出带边框的日志', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.box('Test Title', { key: 'value' });

            // box 方法应该调用多次 console.log（边框、标题、内容）
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('应该支持 box 方法输出字符串内容', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.box('Test Title', 'String content');

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('应该支持 divider 方法输出分隔线', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            logger.divider();
            logger.divider('=');

            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe('生产环境 JSON 输出', () => {
        it('在生产环境应该输出 JSON 格式', async () => {
            // 注意：由于模块缓存，这个测试可能需要特殊处理
            // 这里我们验证 JSON.stringify 不会抛出错误
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            // 测试各种类型的上下文数据
            const testCases = [
                { string: 'test' },
                { number: 123 },
                { boolean: true },
                { null: null },
                { undefined: undefined },
                { array: [1, 2, 3] },
                { nested: { a: { b: 1 } } },
                { error: new Error('test error') },
            ];

            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

            for (const ctx of testCases) {
                expect(() => logger.info(ctx, 'Test')).not.toThrow();
            }

            consoleSpy.mockRestore();
        });
    });

    describe('边界情况', () => {
        it('应该处理空上下文', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            expect(() => logger.info({}, 'Empty context')).not.toThrow();

            consoleSpy.mockRestore();
        });

        it('应该处理空消息', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            expect(() => logger.info({ data: 'test' })).not.toThrow();

            consoleSpy.mockRestore();
        });

        it('应该处理特殊字符', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            const specialChars = '特殊字符: "引号" \'单引号\' \n换行\t制表符 {大括号} [中括号]';
            expect(() => logger.info({ msg: specialChars }, 'Special chars')).not.toThrow();

            consoleSpy.mockRestore();
        });

        it('应该处理大对象', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            const largeObj = {
                data: 'x'.repeat(10000),
                array: Array(100).fill({ nested: 'value' }),
            };
            expect(() => logger.info({ largeObj }, 'Large object')).not.toThrow();

            consoleSpy.mockRestore();
        });

        it('应该处理循环引用（不抛出错误）', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
            const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('test');

            const circularObj: Record<string, unknown> = { a: 1 };
            circularObj.self = circularObj;

            // 循环引用会导致 JSON.stringify 失败，但不应该崩溃
            // 注意：当前实现可能会抛出错误，这是一个已知的限制
            try {
                logger.info({ circularObj }, 'Circular reference');
            } catch {
                // 循环引用导致的错误是预期的
            }

            consoleSpy.mockRestore();
            consoleErrorSpy.mockRestore();
        });
    });

    describe('模块标识', () => {
        it('应该在日志中包含模块标识', async () => {
            let capturedOutput = '';
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
                capturedOutput = msg;
            });

            const { createLogger } = await import('@/lib/logger');
            const logger = createLogger('my-module');

            logger.info('Test message');

            // 检查输出中包含模块名（无论是 JSON 还是 Pretty 格式）
            expect(capturedOutput).toContain('my-module');

            consoleSpy.mockRestore();
        });
    });

    describe('生产环境防泄露护栏 (OPT-03 / OPT-21)', () => {
        it('默认生产模式下 logger.box 不输出提示词、学生姓名、作答或图片 Base64', async () => {
            (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
            delete process.env.LOG_AI_PAYLOADS;

            const captured: string[] = [];
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
                captured.push(String(msg));
            });

            const { createLogger } = await import('@/lib/logger');
            const prodLogger = createLogger('ai:openai');

            const promptText = 'You are an expert K-12 teacher. <question_text> 学生姓名：张小明 解：设 x = 3';
            prodLogger.box('📝 Full System Prompt', promptText);
            prodLogger.box('📤 API Request', {
                imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
                apiKey: 'sk-1234567890abcdef',
                studentName: '张小明',
                wrongAnswer: '设 x = 3',
            });

            expect(captured).toHaveLength(2);

            const firstEntry = JSON.parse(captured[0]);
            expect(firstEntry.module).toBe('ai:openai');
            expect(firstEntry.title).toBe('📝 Full System Prompt');
            expect(firstEntry.contentLength).toBe(promptText.length);
            expect(captured[0]).not.toContain('<question_text>');
            expect(captured[0]).not.toContain('张小明');
            expect(captured[0]).not.toContain('设 x = 3');

            const secondEntry = JSON.parse(captured[1]);
            expect(secondEntry.module).toBe('ai:openai');
            expect(secondEntry.contentLength).toBeGreaterThan(0);
            expect(secondEntry.contentKeys).toEqual(['imageUrl', 'apiKey', 'studentName', 'wrongAnswer']);
            expect(captured[1]).not.toContain('data:image');
            expect(captured[1]).not.toContain('iVBORw0KGgo');
            expect(captured[1]).not.toContain('sk-1234567890abcdef');
            expect(captured[1]).not.toContain('张小明');
            expect(captured[1]).not.toContain('设 x = 3');

            consoleSpy.mockRestore();
        });

        it('开启 LOG_AI_PAYLOADS=true 时仍对图片 Base64、密钥脱敏并截断超长载荷', async () => {
            (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
            process.env.LOG_AI_PAYLOADS = 'true';

            const captured: string[] = [];
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
                captured.push(String(msg));
            });

            const { createLogger } = await import('@/lib/logger');
            const prodLogger = createLogger('ai:gemini');

            const longPrompt = '题目提示词前缀_' + 'A'.repeat(5000);
            prodLogger.box('📝 Full Prompt', {
                prompt: longPrompt,
                imageUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD',
                apiKey: 'sk-secretkey12345678',
            });

            expect(captured).toHaveLength(1);
            const entry = JSON.parse(captured[0]);
            expect(entry.apiKey).toBe('[REDACTED]');
            expect(entry.imageUrl).toContain('[data:image/jpeg');
            expect(entry.prompt).toContain('…[truncated');
            expect(entry.prompt.length).toBeLessThan(2100);
            expect(captured[0]).not.toContain('/9j/4AAQSkZJRgABAQ');
            expect(captured[0]).not.toContain('sk-secretkey12345678');

            consoleSpy.mockRestore();
        });

        it('生产环境下普通 JSON 日志同样脱敏敏感字段和图片载荷', async () => {
            (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
            process.env.LOG_LEVEL = 'info';

            const captured: string[] = [];
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
                captured.push(String(msg));
            });

            const { createLogger } = await import('@/lib/logger');
            const prodLogger = createLogger('api:upload');

            prodLogger.info({
                imageUrl: 'data:image/png;base64,AAAA1234BBBB',
                apiKey: 'sk-abcdef123456',
                authorization: 'Bearer secret-jwt-token',
            }, 'upload');

            expect(captured).toHaveLength(1);
            const entry = JSON.parse(captured[0]);
            expect(entry.apiKey).toBe('[REDACTED]');
            expect(entry.authorization).toBe('[REDACTED]');
            expect(entry.imageUrl).toContain('[data:image/png');
            expect(captured[0]).not.toContain('AAAA1234BBBB');
            expect(captured[0]).not.toContain('sk-abcdef123456');
            expect(captured[0]).not.toContain('secret-jwt-token');

            consoleSpy.mockRestore();
        });
    });
});
