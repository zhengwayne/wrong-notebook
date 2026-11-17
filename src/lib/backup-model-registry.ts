/**
 * 数据备份模型与核心字段覆盖清单（供 OPT-21 DMMF 自动化护栏校验）。
 * 新增 Prisma 模型或往 ErrorItem / PracticeRecord 添加新列时，必须同步更新导入导出逻辑与本清单。
 */

/** 当前导出接口已包含的 Prisma 模型名 -> src/app/api/export/route.ts 查询片段 */
export const BACKUP_EXPORTED_MODELS = {
    User: 'user',
    KnowledgeTag: 'prisma.knowledgeTag',
    Subject: 'prisma.subject',
    ErrorItem: 'prisma.errorItem',
    ReviewSchedule: 'prisma.reviewSchedule',
    PracticeRecord: 'prisma.practiceRecord',
    ExamPaper: 'prisma.examPaper',
    ExamQuestion: 'questions:',
    VariantRun: 'prisma.variantRun',
    VariantItem: 'items:',
    VariantStageLog: 'stages:',
    AiProvenance: 'prisma.aiProvenance',
} as const;

/** 明确不随个人学习迁移包导出的系统/审计表及原因 */
export const BACKUP_EXCLUDED_MODELS = {
    AiUsage: '服务端额度与用量审计流水，不用于跨设备个人学习数据恢复',
    LearnerBackfillAudit: '本机数据库迁移与回填撤销审计日志，仅对当前 SQLite 实例有意义',
} as const;

/** 已登记将在 Batch D（OPT-11a 流式 ZIP 备份 v3）纳入导出导入的多人业务与派生表 */
export const BACKUP_PENDING_V3_MODELS = {
    Learner: 'OPT-11a：多孩子/学生学习者档案映射',
    ParentPaper: 'OPT-11a：家长试卷草稿及页面/题目树',
    ParentPaperPage: 'OPT-11a：家长试卷原图页面（media/<sha256>）',
    ParentPaperQuestion: 'OPT-11a：家长试卷识别题及人工改判状态',
    GradingClass: 'OPT-11a：教师班级花名册',
    GradingStudent: 'OPT-11a：花名册学生档案',
    GradingTask: 'OPT-11a：教师拍照改卷任务',
    GradingKeyQuestion: 'OPT-11a：改卷任务标准答案与得分点',
    GradingSubmission: 'OPT-11a：学生答卷与匹配状态',
    GradingResult: 'OPT-11a：逐题判分结果与人工改判记录',
    KnowledgeMastery: 'OPT-11a：可重算 BKT 知识点掌握度状态（单独归类）',
    LearningPath: 'OPT-11a：可重算个性化学习路径',
    LearningPathStep: 'OPT-11a：学习路径步骤（含教师备注）',
} as const;

export interface FieldCoverageSpec {
    /** 已在 /api/import 创建负载中显式映射写入的标量字段 */
    readonly mapped: readonly string[];
    /** 由数据库自生成或已明确登记至 Batch D OPT-11a 补齐的标量字段 */
    readonly deferredOrGenerated: Record<string, string>;
}

/** ErrorItem 全部标量字段的导入覆盖清单 */
export const ERROR_ITEM_IMPORT_FIELD_COVERAGE: FieldCoverageSpec = {
    mapped: [
        'shortId',
        'userId',
        'subjectId',
        'originalImageUrl',
        'ocrText',
        'questionText',
        'answerText',
        'analysis',
        'wrongAnswerText',
        'mistakeAnalysis',
        'mistakeStatus',
        'knowledgePoints',
        'geogebraCommands',
        'svgAnimation',
        'svgAnimationEn',
        'source',
        'errorType',
        'userNotes',
        'masteryLevel',
        'gradeSemester',
        'paperLevel',
        'difficultyStars',
        'hasFigure',
        'figureSvg',
        'lastPractice',
        'masteryProbability',
        'masteryReason',
        'masterySource',
        'masteryEvaluatedAt',
        'createdAt',
        'updatedAt',
        'provenanceId',
    ],
    deferredOrGenerated: {
        id: '由目标库新生成 CUID 主键并通过 errorItemIdMap 映射关系',
        learnerId: 'OPT-11a（Batch D）：随 Learner 映射关系一并导入恢复',
    },
};

/** PracticeRecord 全部标量字段的导入覆盖清单 */
export const PRACTICE_RECORD_IMPORT_FIELD_COVERAGE: FieldCoverageSpec = {
    mapped: [
        'userId',
        'subject',
        'difficulty',
        'isCorrect',
        'errorItemId',
        'result',
        'questionText',
        'answerText',
        'analysis',
        'wrongAnswerText',
        'mistakeAnalysis',
        'originalImageUrl',
        'figureSvg',
        'source',
        'examQuestionId',
        'createdAt',
    ],
    deferredOrGenerated: {
        id: '由目标库新生成 CUID 主键',
        learnerId: 'OPT-11a（Batch D）：随 Learner 映射关系一并导入恢复',
    },
};
