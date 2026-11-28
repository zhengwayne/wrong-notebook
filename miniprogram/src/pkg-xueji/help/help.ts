/** 我的 › 使用说明（原生）：几件常用的事怎么做，不打开网页 */
const SECTIONS = [
  { key: 'capture', icon: '/assets/icons/camera-p.svg', title: '拍错题', lines: ['首页点「拍题」，一张照片可以有几道题。', '核对题目后存进错题本，按学科自动归类。'] },
  { key: 'grade', icon: '/assets/icons/clipboard-check-p.svg', title: '整页批改', lines: ['家长拍孩子整页作业或试卷，逐题标对错。', '判错和半对的题确认后进孩子的错题本。'] },
  { key: 'review', icon: '/assets/icons/calendar-check-p.svg', title: '每天复习', lines: ['错题按计划出现在「复习」里。', '先自己做，再标记对了、错了或不会。'] },
  { key: 'detail', icon: '/assets/icons/file-text-p.svg', title: '查看详情', lines: ['错题和批改的每道题都能点「查看详情」。', '看题图、当时写的、做题记录，写笔记。'] },
  { key: 'lock', icon: '/assets/icons/lock-p.svg', title: '专注模式', lines: ['「我的」里给孩子开专注模式，只能做题和复习。', '退出要输入家长 PIN。'] },
  { key: 'pc', icon: '/assets/icons/monitor-p.svg', title: '老师改卷', lines: ['建班级、收卷、复核适合在电脑上做。', '新手引导里的这几步会给出链接，复制到电脑浏览器打开。'] },
];

Page({
  data: { sections: SECTIONS },
});
