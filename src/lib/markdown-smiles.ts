/**
 * 把 ```smiles 代码块变成自定义节点，不走 rehype-raw，也不渲染其它 HTML。
 */
import type { Code, Root } from 'mdast';
import { visit } from 'unist-util-visit';

export const SMILES_LANG = 'smiles';

/** remark 插件：仅识别语言为 smiles 的围栏代码块 */
export function remarkSafeSmiles() {
    return (tree: Root) => {
        visit(tree, 'code', (node: Code, index, parent) => {
            if (index == null || !parent) return;
            if ((node.lang ?? '').toLowerCase() !== SMILES_LANG) return;
            const smiles = node.value.trim();
            parent.children[index] = {
                type: 'smiles',
                data: {
                    hName: 'smiles-structure',
                    hProperties: { 'data-smiles': smiles },
                },
                children: smiles ? [{ type: 'text', value: smiles }] : [],
            } as unknown as typeof parent.children[number];
        });
    };
}
