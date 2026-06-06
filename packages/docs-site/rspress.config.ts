import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspress/core'
import { mermaidPlugin } from './plugins/mermaid'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: path.join(here, 'docs'),
  plugins: [mermaidPlugin()],
  globalStyles: path.join(here, 'theme/theme.css'),
  title: 'Owl ID',
  description: 'Privacy-preserving digital identity built on Midnight.',
  logoText: 'Owl ID',
  base: '/',
  outDir: 'doc_build',
  themeConfig: {
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/owlid/owlid',
      },
      {
        icon: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
        },
        mode: 'link',
        content: 'https://wallet.owlid.app',
      },
    ],
    nav: [
      { text: 'Docs', link: '/overview' },
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'SDK', link: '/sdk/verifier' },
      { text: 'Apps', link: '/apps' },
      { text: 'Examples', link: '/examples/scenarios' },
    ],
    sidebar: {
      '/': [
        {
          text: 'Get started',
          items: [
            { text: 'Overview', link: '/overview' },
            { text: 'Quickstart', link: '/quickstart' },
          ],
        },
        {
          text: 'Integration',
          items: [
            { text: 'Verifier', link: '/integration/verifier' },
            { text: 'Issuer', link: '/integration/issuer' },
            { text: 'Holder app', link: '/integration/holder' },
          ],
        },
        {
          text: 'SDK reference',
          items: [
            { text: 'OwlVerifier', link: '/sdk/verifier' },
            { text: 'OwlIssuer', link: '/sdk/issuer' },
            { text: 'Token primitives', link: '/sdk/primitives' },
          ],
        },
        {
          text: 'Concepts',
          items: [{ text: 'How Owl ID works', link: '/architecture/overview' }],
        },
        {
          text: 'Apps',
          items: [{ text: 'Wallet, verifier, dashboard', link: '/apps' }],
        },
        {
          text: 'Examples',
          items: [{ text: 'Real-world scenarios', link: '/examples/scenarios' }],
        },
      ],
    },
    footer: {
      message: 'MIT licensed.',
    },
    enableContentAnimation: true,
  },
  markdown: {
    showLineNumbers: true,
    defaultWrapCode: false,
  },
})
