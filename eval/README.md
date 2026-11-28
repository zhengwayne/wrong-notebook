# AI 离线评测套件（OPT-19）

默认 CLI 使用合成题离线验证答案判等和结构化解析。识题、批改与整卷识别采用确定性回放，表中的模型名称是回放标签，耗时与成本是样例值。比较实际模型或提示词时，可在 `runEvaluation` 的提供商配置中传入调用模型或读取实测结果的 `runCase`。

## 1. 数据来源与隐私承诺

- 评测集 **100% 使用合成题与公开课标基础题**，严禁放入任何真实学生照片、姓名、学号、手写笔记扫描件或真实试卷原图。
- 所有样本均由项目维护者依据义务教育及高中通用学科课标知识编写，以 **CC0 / MIT** 许可随仓库开放。
- 涉及图片输入评测时，由评测工具根据描述在内存中动态生成干净合成测试图（并剥离元数据），不在仓库提交冗余大体积图像。

## 2. 目录结构

```
eval/
  README.md
  run-eval.ts                      # 按 task × provider × model 运行，输出 JSON 与 Markdown 报告
  baselines/
    baseline-sample.json           # 历史参考基线
  datasets/
    verify/golden-cases.json       # 纯文本数学验算、结构化判等与 LaTeX JSON 修复用例（随 npm run test:unit 运行）
    analyze/cases.json             # 覆盖 9 科的合成识题样本（30 例）
    grading/cases.json             # 含错题判对陷阱的合成判分样本（30 例）
    exam-read/cases.json           # 合成整卷读卷样本（30 例）
```

## 3. 核心指标

- `stemSimilarityAvg`：归一化 Levenshtein 编辑相似度
- `answerMatchRate`：答案结构化匹配率
- `tagF1` / `perSubjectTagF1`：全 9 科知识点标签 F1（直接验证 OPT-04）
- `gradingAccuracy` 与 `wrongMarkedCorrectRate`：判题准确率，以及**把错题判成对的比例**（红线指标）
- `jsonParseFailureRate`、`p95LatencyMs`、`costPerItem`

## 4. 运行方式与 PR 门禁规范

### 单元测试直接校验（无需 API Key）
```bash
npm run test:unit -- src/__tests__/unit/eval-verify-dataset.test.ts src/__tests__/unit/eval-runner.test.ts
```

### 运行双提供商离线评测与基线对比
```bash
node eval/cli.mjs --task all --provider replay-a,replay-beta-degraded --baseline eval/baselines/baseline-sample.json
```

### PR 规范
凡是修改 `src/lib/ai/prompts.ts`、解析器（`src/lib/ai/parse-analyze.ts`、`src/lib/ai/schema.ts`、`src/lib/variant/verify.ts`）或默认模型预设的 PR，均应附上 `eval/run-eval.ts` 生成的评测对比报告；若核心指标相对基线下降超过 **2 个百分点**（或 `wrongMarkedCorrectRate` / `jsonParseFailureRate` 上升超过 2 个百分点），必须在 PR 中给出原因说明。
