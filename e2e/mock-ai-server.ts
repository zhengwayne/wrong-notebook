import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIRequestContext } from '@playwright/test';

interface ChatMessage {
    role?: string;
    content?: unknown;
}

function extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
                    return (part as { text: string }).text;
                }
                return '';
            })
            .join('\n');
    }
    return '';
}

function resolveMockCompletion(messages: ChatMessage[]): string {
    const combined = messages.map((m) => extractTextFromContent(m.content)).join('\n');

    if (combined.includes('拆分试卷并逐题判断对错') || combined.includes('split the exam paper')) {
        return JSON.stringify({
            questions: [
                {
                    number: '1',
                    type: 'objective',
                    questionText: '已知 $x^2 - 5x + 6 = 0$，求 $x$ 的解。',
                    studentAnswer: 'x = 1',
                    correctAnswer: 'x = 2 或 x = 3',
                    verdict: 'wrong',
                    confidence: 0.94,
                    errorCause: '因式分解符号错误',
                    knowledgePoints: ['一元二次方程'],
                    subjectHint: '数学',
                    bbox: { pageIndex: 0, x: 0.08, y: 0.12, width: 0.84, height: 0.28 },
                },
                {
                    number: '2',
                    type: 'objective',
                    questionText: '计算 $2 + 3$ 的值。',
                    studentAnswer: '5',
                    correctAnswer: '5',
                    verdict: 'correct',
                    confidence: 0.98,
                    errorCause: null,
                    knowledgePoints: ['有理数加法'],
                    subjectHint: '数学',
                    bbox: { pageIndex: 0, x: 0.08, y: 0.45, width: 0.84, height: 0.25 },
                },
            ],
        });
    }

    if (combined.includes('请读出卷头的班级、学号和姓名')) {
        return JSON.stringify({
            studentName: '张小明',
            className: '初二(1)班',
            studentNo: '01',
            questions: [],
        });
    }

    if (combined.includes('请识别图片中的标准答案')) {
        return JSON.stringify({
            questions: [
                { number: '1', type: 'objective', maxScore: 5, answer: 'A', questionText: '测试选择题' },
            ],
        });
    }

    if (combined.includes('请识别图片中学生的作答并按规则评分')) {
        return JSON.stringify({
            studentName: '张小明',
            className: '初二(1)班',
            studentNo: '01',
            questions: [
                { number: '1', answer: 'B', score: 0, reason: '答案有误' },
                { number: '2', answer: '写了部分步骤', score: 2, reason: '缺少关键推导' },
            ],
        });
    }

    return [
        '<item>',
        '<questionText>E2E 模拟错题：解方程 $x + 2 = 5$</questionText>',
        '<answerText>$x = 3$</answerText>',
        '<analysis>移项得 $x = 3$。</analysis>',
        '<knowledgePoints>一元一次方程</knowledgePoints>',
        '<subject>数学</subject>',
        '</item>',
    ].join('\n');
}

export interface MockAiServer {
    baseUrl: string;
    requests: string[];
    close: () => Promise<void>;
}

/** 启动监听 127.0.0.1 随机端口的本地 OpenAI 兼容 Mock 服务端 */
export async function startMockAiServer(): Promise<MockAiServer> {
    const requests: string[] = [];

    const server = http.createServer((req, res) => {
        const url = req.url || '';
        if (req.method === 'GET' && url.endsWith('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] }));
            return;
        }

        if (req.method === 'POST' && url.endsWith('/chat/completions')) {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                        model?: string;
                        messages?: ChatMessage[];
                    };
                    const content = resolveMockCompletion(body.messages || []);
                    requests.push(url);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: `chatcmpl-mock-${Date.now()}`,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: body.model || 'gpt-4o-mini',
                        choices: [
                            {
                                index: 0,
                                message: { role: 'assistant', content },
                                finish_reason: 'stop',
                            },
                        ],
                        usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
                    }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: String(error) } }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        requests,
        close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
}

/** 通过已认证的管理员 API 上下文临时指向本地 Mock AI 并返回可还原旧配置的函数 */
export async function configureMockOpenAi(
    adminApi: APIRequestContext,
    mockBaseUrl: string,
): Promise<() => Promise<void>> {
    const getRes = await adminApi.get('/api/settings');
    if (!getRes.ok()) {
        throw new Error(`Failed to fetch current settings: ${getRes.status()}`);
    }
    const prev = await getRes.json() as Record<string, unknown>;

    const setRes = await adminApi.post('/api/settings', {
        data: {
            aiProvider: 'openai',
            textSameAsVision: true,
            openai: {
                activeInstanceId: 'e2e-mock-instance',
                instances: [
                    {
                        id: 'e2e-mock-instance',
                        name: 'E2E Mock OpenAI',
                        apiKey: 'sk-e2e-mock-key',
                        baseUrl: mockBaseUrl,
                        model: 'gpt-4o-mini',
                    },
                ],
            },
        },
    });
    if (!setRes.ok()) {
        throw new Error(`Failed to update settings to mock AI: ${setRes.status()} ${await setRes.text()}`);
    }

    return async () => {
        await adminApi.post('/api/settings', {
            data: {
                aiProvider: prev.aiProvider,
                textSameAsVision: prev.textSameAsVision ?? true,
                ...(prev.openai ? { openai: prev.openai } : {}),
            },
        });
    };
}
