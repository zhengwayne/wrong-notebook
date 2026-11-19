/** 生成按钮上附带专题名：括号样式由当前语言的模板决定（中文全角、英文半角） */
export function withTopicLabel(template: string, label: string, topic: string): string {
    return template.replace("{label}", label).replace("{topic}", topic);
}
