/**
 * 应用配置模块单元测试
 * 测试 getAppConfig 和 updateAppConfig 函数
 * 注意：这些测试 mock 了文件系统操作
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// Mock fs module
vi.mock('fs', () => {
    const mocked = { readFileSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn() };
    return { default: mocked, ...mocked };
});

/** 模拟配置文件不存在 */
function mockNoConfigFile() {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
}

// Store original env
const originalEnv = { ...process.env };

describe('config module', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset environment variables
        process.env = { ...originalEnv };
        // Clear module cache to re-import with fresh state
        vi.resetModules();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('getAppConfig', () => {
        it('应该返回默认配置（文件不存在时）', async () => {
            mockNoConfigFile();

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.aiProvider).toBe('minimax'); // 默认值
            expect(config.allowRegistration).toBe(false);
            expect(config.timeZone).toBe('Asia/Shanghai');
        });

        it.each([
            ['true', true],
            ['false', false],
            ['1', false],
        ])('ALLOW_REGISTRATION=%s 时默认注册开关为 %s', async (value, expected) => {
            process.env.ALLOW_REGISTRATION = value;
            mockNoConfigFile();

            const { getAppConfig } = await import('@/lib/config');

            expect(getAppConfig().allowRegistration).toBe(expected);
        });

        it.each([
            ['20', 20],
            ['0', 0],
            ['-5', 0],
            ['2.5', 0],
            ['abc', 0],
            [undefined, 0],
        ])('AI_DAILY_LIMIT=%s 时默认每日 AI 次数为 %s', async (value, expected) => {
            if (value === undefined) delete process.env.AI_DAILY_LIMIT;
            else process.env.AI_DAILY_LIMIT = value;
            mockNoConfigFile();

            const { getAppConfig } = await import('@/lib/config');

            expect(getAppConfig().aiDailyLimit).toBe(expected);
        });

        it.each([
            ['8', 8],
            ['0', 5],
            ['abc', 5],
            [undefined, 5],
        ])('AI_CONCURRENCY_LIMIT=%s 时默认并发上限为 %s', async (value, expected) => {
            if (value === undefined) delete process.env.AI_CONCURRENCY_LIMIT;
            else process.env.AI_CONCURRENCY_LIMIT = value;
            mockNoConfigFile();

            const { getAppConfig } = await import('@/lib/config');

            expect(getAppConfig().aiConcurrencyLimit).toBe(expected);
        });

        it('配置文件中保存的注册开关优先于环境变量', async () => {
            process.env.ALLOW_REGISTRATION = 'false';
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ allowRegistration: true }));

            const { getAppConfig } = await import('@/lib/config');

            expect(getAppConfig().allowRegistration).toBe(true);
        });

        it.each([undefined, null, 'invalid/zone'])('旧配置或无效时区 %s 回退为北京时间', async (timeZone) => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ aiProvider: 'gemini', timeZone }));
            const { getAppConfig, getAppTimeZone } = await import('@/lib/config');
            expect(getAppConfig().timeZone).toBe('Asia/Shanghai');
            expect(getAppTimeZone()).toBe('Asia/Shanghai');
        });

        it('可保存并重新读取管理员配置的时区', async () => {
            mockNoConfigFile();
            const { updateAppConfig, getAppTimeZone } = await import('@/lib/config');
            const config = updateAppConfig({ timeZone: 'America/New_York' });
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
            expect(getAppTimeZone()).toBe('America/New_York');
            expect(fs.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('"timeZone": "America/New_York"'), { mode: 0o600 });
        });

        it('直接写配置也拒绝无效时区', async () => {
            mockNoConfigFile();
            const { updateAppConfig } = await import('@/lib/config');
            expect(() => updateAppConfig({ timeZone: 'invalid/zone' })).toThrow('INVALID_TIME_ZONE');
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        });

        it('应该从环境变量读取 AI Provider', async () => {
            mockNoConfigFile();
            process.env.AI_PROVIDER = 'openai';

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.aiProvider).toBe('openai');
        });

        it('应该从环境变量读取 API Keys', async () => {
            mockNoConfigFile();
            process.env.OPENAI_API_KEY = 'sk-env-key';
            process.env.GOOGLE_API_KEY = 'AIza-env-key';

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            // OpenAI 现在使用多实例格式
            expect(config.openai?.instances?.[0]?.apiKey).toBe('sk-env-key');
            expect(config.gemini?.apiKey).toBe('AIza-env-key');
        });

        it('应该从配置文件读取并与默认值合并', async () => {
            // 新格式的配置文件
            const fileConfig = {
                aiProvider: 'openai',
                openai: {
                    instances: [{
                        id: 'test-instance',
                        name: 'Test',
                        apiKey: 'sk-file-key',
                        baseUrl: 'https://api.openai.com/v1',
                        model: 'gpt-4o',
                    }],
                    activeInstanceId: 'test-instance',
                },
            };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(fileConfig));

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.aiProvider).toBe('openai');
            expect(config.openai?.instances?.[0]?.apiKey).toBe('sk-file-key');
            // 其他默认值应该保留
            expect(config.allowRegistration).toBe(false);
            expect(config.gemini).toBeDefined();
        });

        it('应该在配置文件解析失败时返回默认值', async () => {
            vi.mocked(fs.readFileSync).mockReturnValue('invalid json{');

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            // 应该回退到默认配置
            expect(config.aiProvider).toBeDefined();
        });

        it('应该使用环境变量的模型名称', async () => {
            mockNoConfigFile();
            process.env.OPENAI_API_KEY = 'sk-test';
            process.env.OPENAI_MODEL = 'gpt-4-turbo';
            process.env.GEMINI_MODEL = 'gemini-3.0';

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.openai?.instances?.[0]?.model).toBe('gpt-4-turbo');
            expect(config.gemini?.model).toBe('gemini-3.0');
        });

        it('应该使用默认模型名称（无环境变量时）', async () => {
            mockNoConfigFile();
            process.env.OPENAI_API_KEY = 'sk-test';
            delete process.env.OPENAI_MODEL;
            delete process.env.GEMINI_MODEL;

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.openai?.instances?.[0]?.model).toBe('gpt-6.1-sol');
            expect(config.gemini?.model).toBe('gemini-2.5-flash');
        });

        it('国产大模型渠道读取 <PREFIX>_API_KEY / _BASE_URL / _MODEL 环境变量', async () => {
            mockNoConfigFile();
            const { VENDOR_PROVIDER_IDS, VENDOR_PRESETS } = await import('@/lib/ai/vendor-presets');
            for (const id of VENDOR_PROVIDER_IDS) {
                const prefix = VENDOR_PRESETS[id].envPrefix;
                process.env[`${prefix}_API_KEY`] = `${id}-key`;
                process.env[`${prefix}_MODEL`] = `${id}-model`;
            }

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            for (const id of VENDOR_PROVIDER_IDS) {
                expect(config[id]).toMatchObject({ apiKey: `${id}-key`, model: `${id}-model` });
            }
        });

        it('国产大模型渠道合并文件配置与环境变量', async () => {
            const { VENDOR_PROVIDER_IDS, VENDOR_PRESETS } = await import('@/lib/ai/vendor-presets');
            const id = VENDOR_PROVIDER_IDS[0];
            process.env[`${VENDOR_PRESETS[id].envPrefix}_API_KEY`] = 'env-key';
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ aiProvider: id, [id]: { model: 'file-model' } }));

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.aiProvider).toBe(id);
            expect(config[id]).toMatchObject({ apiKey: 'env-key', model: 'file-model' });
        });

        it('读取已有配置时去掉模型名、地址和密钥的首尾空白', async () => {
            const fileConfig = {
                aiProvider: 'openai',
                openai: {
                    instances: [{
                        id: 'test-instance',
                        name: 'Test',
                        apiKey: ' sk-file-key\t',
                        baseUrl: ' https://api.example.com/v1\t',
                        model: 'gemini-4-hydrogen-medium\t',
                    }],
                    activeInstanceId: 'test-instance',
                },
                gemini: { apiKey: ' gm-key ', model: '  gemini-2.5-flash  ' },
                textAi: {
                    openai: {
                        instances: [{ id: 'text', name: 'Text', apiKey: ' text-key\n', model: ' text-model ' }],
                        activeInstanceId: 'text',
                    },
                },
            };
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(fileConfig));

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();

            expect(config.openai?.instances?.[0]?.model).toBe('gemini-4-hydrogen-medium');
            expect(config.openai?.instances?.[0]?.baseUrl).toBe('https://api.example.com/v1');
            expect(config.openai?.instances?.[0]?.apiKey).toBe('sk-file-key');
            expect(config.gemini?.model).toBe('gemini-2.5-flash');
            expect(config.gemini?.apiKey).toBe('gm-key');
            expect(config.textAi?.openai?.instances?.[0]?.model).toBe('text-model');
            expect(config.textAi?.openai?.instances?.[0]?.apiKey).toBe('text-key');
        });
    });

    describe('updateAppConfig', () => {
        it('应该成功写入配置文件', async () => {
            mockNoConfigFile();
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });

            const { updateAppConfig } = await import('@/lib/config');
            const result = updateAppConfig({ aiProvider: 'openai' });

            expect(fs.writeFileSync).toHaveBeenCalled();
            expect(result.aiProvider).toBe('openai');
        });

        it('保存时去掉模型名、地址和密钥的首尾空白', async () => {
            mockNoConfigFile();
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });

            const { updateAppConfig } = await import('@/lib/config');
            const result = updateAppConfig({
                openai: {
                    instances: [{
                        id: 'test-instance',
                        name: 'Test',
                        apiKey: ' sk-save\t',
                        baseUrl: ' https://api.example.com/v1 ',
                        model: 'gemini-4-hydrogen-medium\t',
                    }],
                    activeInstanceId: 'test-instance',
                },
                textAi: { gemini: { apiKey: ' text-save ', model: ' text-gemini ' } },
            });

            expect(result.openai?.instances?.[0]?.model).toBe('gemini-4-hydrogen-medium');
            expect(result.openai?.instances?.[0]?.apiKey).toBe('sk-save');
            expect(result.openai?.instances?.[0]?.baseUrl).toBe('https://api.example.com/v1');
            expect(result.textAi?.gemini?.model).toBe('text-gemini');
            const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
            expect(written.openai.instances[0].model).toBe('gemini-4-hydrogen-medium');
        });

        it('先写临时文件再改名替换，避免读到写了一半的配置', async () => {
            mockNoConfigFile();

            const { updateAppConfig } = await import('@/lib/config');
            updateAppConfig({ aiProvider: 'openai' });

            const tmp = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;
            expect(tmp).toMatch(/app-config\.json\.\d+\.\d+\.\d+\.tmp$/);
            expect(fs.writeFileSync).toHaveBeenCalledWith(tmp, expect.any(String), { mode: 0o600 });
            expect(fs.renameSync).toHaveBeenCalledWith(tmp, expect.stringMatching(/app-config\.json$/));
        });

        it('迁移旧版 OpenAI 配置时使用标准 UUID 且以 0o600 落盘', async () => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                aiProvider: 'openai',
                openai: { apiKey: 'sk-legacy', model: 'gpt-4o' },
            }));
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });
            vi.mocked(fs.renameSync).mockImplementation(() => { });

            const { getAppConfig } = await import('@/lib/config');
            const config = getAppConfig();
            const instanceId = config.openai?.instances?.[0]?.id;

            expect(instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                expect.stringMatching(/app-config\.json\.\d+\.\d+\.\d+\.tmp$/),
                expect.any(String),
                { mode: 0o600 }
            );
        });

        it('配置文件无法读取（非不存在）时记录错误并返回默认配置', async () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => {
                throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            });

            const { getAppConfig } = await import('@/lib/config');
            expect(getAppConfig().aiProvider).toBeDefined();
        });

        it('应该合并嵌套配置', async () => {
            mockNoConfigFile();
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });

            const { updateAppConfig } = await import('@/lib/config');
            const result = updateAppConfig({
                openai: {
                    instances: [{
                        id: 'new-instance',
                        name: 'New',
                        apiKey: 'new-key',
                        baseUrl: 'https://api.openai.com/v1',
                        model: 'gpt-4o',
                    }],
                    activeInstanceId: 'new-instance',
                },
            });

            expect(result.openai?.instances?.[0]?.apiKey).toBe('new-key');
            // 实例应该存在
            expect(result.openai?.instances?.length).toBeGreaterThan(0);
        });

        it('应该在写入失败时抛出错误', async () => {
            mockNoConfigFile();
            vi.mocked(fs.writeFileSync).mockImplementation(() => {
                throw new Error('Permission denied');
            });

            const { updateAppConfig } = await import('@/lib/config');

            expect(() => updateAppConfig({ aiProvider: 'openai' })).toThrow();
        });

        it('应该更新提示词配置', async () => {
            mockNoConfigFile();
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });

            const { updateAppConfig } = await import('@/lib/config');
            const result = updateAppConfig({
                prompts: { analyze: '自定义提示词' },
            });

            expect(result.prompts?.analyze).toBe('自定义提示词');
        });

        it('应该更新注册开关', async () => {
            mockNoConfigFile();
            vi.mocked(fs.writeFileSync).mockImplementation(() => { });

            const { updateAppConfig } = await import('@/lib/config');
            const result = updateAppConfig({ allowRegistration: false });

            expect(result.allowRegistration).toBe(false);
        });
    });

    describe('文本与多模态模型角色', () => {
        it('旧版单渠道配置在读取时应把文本角色视为与多模态相同', async () => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                aiProvider: 'gemini',
                gemini: { apiKey: 'legacy-key', model: 'gemini-2.5-flash' },
            }));
            const { getAppConfig } = await import('@/lib/config');
            const { isTextSameAsVision, getConfigForRole } = await import('@/lib/ai/roles');
            const config = getAppConfig();
            expect(isTextSameAsVision(config)).toBe(true);
            expect(getConfigForRole(config, 'text').aiProvider).toBe('gemini');
            expect(getConfigForRole(config, 'text').gemini?.apiKey).toBe('legacy-key');
            expect(getConfigForRole(config, 'text').gemini?.model).toBe('gemini-2.5-flash');
        });

        it('关闭共用后文本角色使用独立渠道和模型', async () => {
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
                aiProvider: 'gemini',
                gemini: { apiKey: 'vision-key', model: 'gemini-flash' },
                textSameAsVision: false,
                aiTextProvider: 'minimax',
                textAi: { minimax: { apiKey: 'text-key', model: 'MiniMax-M3.1-Flash' } },
            }));
            const { getAppConfig } = await import('@/lib/config');
            const { isTextSameAsVision, getConfigForRole } = await import('@/lib/ai/roles');
            const config = getAppConfig();
            expect(isTextSameAsVision(config)).toBe(false);
            expect(getConfigForRole(config, 'vision').aiProvider).toBe('gemini');
            expect(getConfigForRole(config, 'vision').gemini?.model).toBe('gemini-flash');
            const text = getConfigForRole(config, 'text');
            expect(text.aiProvider).toBe('minimax');
            expect(text.minimax?.apiKey).toBe('text-key');
            expect(text.minimax?.model).toBe('MiniMax-M3.1-Flash');
        });
    });
});
