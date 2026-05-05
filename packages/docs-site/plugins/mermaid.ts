/**
 * Local mermaid plugin for rspress 2.
 *
 * Converts fenced ```mermaid blocks in MDX into <Mermaid code="..."/> JSX
 * elements that render to SVG client-side.
 *
 * Bypasses `rspress-plugin-mermaid` because that plugin's component path
 * lives outside the project root and webpack's module factory fails to
 * register the lazy chunk in rspress 2.0.10.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RspressPlugin } from '@rspress/core'
import type { Code, Root } from 'mdast'
import { visit } from 'unist-util-visit'

const here = path.dirname(fileURLToPath(import.meta.url))

function remarkMermaid() {
  return (tree: Root) => {
    visit(tree, 'code', (node: Code, index, parent) => {
      if (node.lang !== 'mermaid' || !parent || index === undefined) return
      const code = node.value
      // Replace the code block with a JSX flow expression.
      // rspress 2's MDX pipeline accepts `mdxJsxFlowElement` nodes directly.
      ;(parent.children as Array<unknown>)[index] = {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [
          {
            type: 'mdxJsxAttribute',
            name: 'code',
            value: code,
          },
        ],
        children: [],
      }
    })
  }
}

export function mermaidPlugin(): RspressPlugin {
  return {
    name: 'owlid-mermaid',
    markdown: {
      remarkPlugins: [remarkMermaid],
      globalComponents: [path.join(here, '..', 'theme', 'Mermaid.tsx')],
    },
  }
}
