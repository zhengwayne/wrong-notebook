/**
 * 数据备份模型与核心字段覆盖清单（供 OPT-21 DMMF 自动化护栏校验）。
 * 新增 Prisma 模型或往 ErrorItem / PracticeRecord 添加新列时，必须同步更新 v3 备份模块与本清单。
 */

/** 备份 v3 已完整导出并在导入中恢复/处置的 Prisma 模型 -> src/lib/backup/export-v3.ts 导出标记 */
export const BACKUP_EXPORTED_MODELS = {
    User: 'db.user.findMany',
    Learner: 'db.learner.findMany',
    GradingClass: 'db.gradingClass.findMany',
    GradingStudent: 'db.gradingStudent.findMany',
    Subject: 'db.subject.findMany',
    KnowledgeTag: 'db.knowledgeTag.findMany',
    AiProvenance: 'db.aiProvenance.findMany',
    ErrorItem: 'db.errorItem.findMany',
    ReviewSchedule: 'db.reviewSchedule.findMany',
    ExamPaper: 'db.examPaper.findMany',
    ExamQuestion: 'db.examQuestion.findMany',
    PracticeRecord: 'db.practiceRecord.findMany',
    ParentPaper: 'db.parentPaper.findMany',
    ParentPaperPage: 'db.parentPaperPage.findMany',
    ParentPaperQuestion: 'db.parentPaperQuestion.findMany',
    GradingTask: 'db.gradingTask.findMany',
    GradingKeyQuestion: 'db.gradingKeyQuestion.findMany',
    GradingSubmission: 'db.gradingSubmission.findMany',
    GradingResult: 'db.gradingResult.findMany',
    VariantRun: 'db.variantRun.findMany',
    VariantItem: 'db.variantItem.findMany',
    VariantStageLog: 'db.variantStageLog.findMany',
    KnowledgeMastery: 'db.knowledgeMastery.findMany',
    ItemMemory: 'db.itemMemory.findMany',
    LearningPath: 'db.learningPath.findMany',
    LearningPathStep: 'db.learningPathStep.findMany',
} as const;

/** 明确不随个人学习迁移包导出的系统/审计表及原因 */
export const BACKUP_EXCLUDED_MODELS = {
    AiUsage: '服务端额度与用量审计流水，不用于跨设备个人学习数据恢复',
    LearnerBackfillAudit: '本机数据库迁移与回填撤销审计日志，仅对当前 SQLite 实例有意义',
    SourceImport: '批改确认与家长试卷导入的本地并发去重映射，不用于跨设备个人学习数据恢复',
} as const;

/** OPT-11a 已交付全部多人与派生表导出，本列表严格保持为空 */
export const BACKUP_PENDING_V3_MODELS: Record<string, string> = {};

export interface FieldCoverageSpec {
    /** 已在 v3 导入创建负载中显式映射写入的标量字段 */
    readonly mapped: readonly string[];
    /** 由数据库自生成主键等明确不从备份直写的字段 */
    readonly deferredOrGenerated: Record<string, string>;
}

/** ErrorItem 全部标量字段的导入覆盖清单 */
export const ERROR_ITEM_IMPORT_FIELD_COVERAGE: FieldCoverageSpec = {
    mapped: [
        'shortId',
        'userId',
        'subjectId',
        'learnerId',
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
    },
};

/** PracticeRecord 全部标量字段的导入覆盖清单 */
export const PRACTICE_RECORD_IMPORT_FIELD_COVERAGE: FieldCoverageSpec = {
    mapped: [
        'userId',
        'learnerId',
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
        id: '由目标库新生成 CUID 主键并通过 practiceRecordIdMap 映射关系',
    },
};
