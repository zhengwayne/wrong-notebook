/**
 * NewAPI 模型检查与测速脚本
 * 功能：
 * 1. 从指定的 NewAPI/OpenAI 接口获取所有可用模型列表。
 * 2. 筛选支持视觉 (Vision) 的模型。
 * 3. 对支持视觉的模型进行实际图片识别测试，并测量响应时间。
 * 4. 按响应速度排序输出结果。
 * 用途：用于评估不同模型的可用性、视觉能力及响应速度，帮助选择最佳模型。
 */
const fs = require("fs");
const path = require("path");
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function checkModelsAndVision() {
    console.log("Checking available models and vision support from NewAPI...");

    const baseURL = process.env.OPENAI_BASE_URL?.trim();
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!baseURL || !apiKey) {
        console.error('请设置 OPENAI_BASE_URL 与 OPENAI_API_KEY 以指定本次测速的服务。');
        process.exitCode = 1;
        return;
    }
    const rootURL = baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');

    // 1. Fetch Models
    const modelsUrl = `${rootURL}/v1/models`;
    console.log("正在获取已配置服务的模型列表。");

    let availableModels = [];

    try {
        const response = await fetch(modelsUrl, {
            method: 'GET',
            redirect: 'error',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        });

        if (!response.ok) {
            console.error(`模型列表请求失败，HTTP ${response.status}。`);
            process.exitCode = 1;
            return;
        }

        const data = await response.json();

        if (data.object === 'list' && Array.isArray(data.data)) {
            availableModels = data.data.map(m => m.id).sort();
            console.log(`✅ Found ${availableModels.length} models.`);
        } else if (data.success && data.data) {
            // Handle NewAPI specific format if /v1/models returns it (unlikely but possible)
            const allModels = new Set();
            for (const models of Object.values(data.data)) {
                models.forEach(m => allModels.add(m));
            }
            availableModels = Array.from(allModels).sort();
            console.log(`✅ Found ${availableModels.length} models (NewAPI format).`);
        } else {
            console.error("模型列表格式无法识别。");
            process.exitCode = 1;
            return;
        }

    } catch {
        console.error("模型列表请求失败。");
        process.exitCode = 1;
        return;
    }

    // 允许本地指定测试样图；缺省使用项目自带的公开 PNG 图标。
    const localImage = path.join(__dirname, "1.png");
    const imagePath = fs.existsSync(localImage) ? localImage : path.join(__dirname, "../public/icons/icon.png");
    const base64Image = fs.readFileSync(imagePath).toString("base64");
    const mimeType = "image/png";

    // 3. Test Vision Support
    console.log("\n--- Testing Vision Support (Sampling 5 models + known vision models) ---");

    // Filter for likely vision models to prioritize testing, plus some random ones
    const visionKeywords = ["vision", "4v", "4o", "gemini", "claude-3", "llava"];
    const likelyVisionModels = availableModels.filter(m => visionKeywords.some(k => m.toLowerCase().includes(k)));

    // Let's test specific models of interest + likely vision ones
    // De-duplicate
    const modelsToTest = [...new Set([...likelyVisionModels])];

    console.log(`Testing ${modelsToTest.length} potential vision models...`);

    const supportedModels = [];

    for (const model of modelsToTest) {
        process.stdout.write(`Testing ${model}... `);

        const chatUrl = `${rootURL}/v1/chat/completions`;
        const payload = {
            model: model,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Describe this image in 3 words." },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 10
        };

        try {
            const startTime = Date.now();
            const res = await fetch(chatUrl, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            const resData = await res.json();
            const endTime = Date.now();
            const duration = endTime - startTime;

            if (res.ok) {
                // Check if it actually processed the image or ignored it (some text models might just ignore the image part)
                // But usually if they don't support it, they error out or complain.
                // Or if they return a description, it's supported.
                if (resData.choices && resData.choices.length > 0) {
                    console.log(`✅ Supported (${duration}ms)`);
                    supportedModels.push({ name: model, duration: duration });
                } else {
                    console.log(`❓ Empty response (${duration}ms)`);
                }
            } else {
                // Common errors: 400 (invalid request, likely image not supported), 422
                const msg = resData.error ? resData.error.message : "Unknown error";
                if (msg.includes("vision") || msg.includes("image") || msg.includes("multimodal") || res.status === 400) {
                    console.log(`❌ Not Supported (${res.status})`);
                } else {
                    console.log(`❌ 模型请求失败，HTTP ${res.status}。`);
                }
            }

        } catch {
            console.log("❌ 模型请求或解析响应失败。");
        }
    }

    console.log("\n--- Vision Support Summary (Sorted by Speed) ---");
    console.log("✅ Models with Vision Support:");
    supportedModels.sort((a, b) => a.duration - b.duration).forEach(m => console.log(`  - ${m.name}: ${m.duration}ms`));
}

checkModelsAndVision();
