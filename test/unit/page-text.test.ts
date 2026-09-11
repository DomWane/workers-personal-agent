import { describe, expect, it } from 'vitest'
import { extractMain } from '@/agent/tools/page-text'

const ARTICLE = [
  'Andrej Karpathy popisuje, jak používá jazykové modely v každodenní práci, a rozděluje',
  'je podle toho, jestli jde o psaní kódu, nebo o přemýšlení nad problémem.',
  '',
  'Klíčová myšlenka je, že model má sloužit jako nástroj na první návrh, ne jako autorita.',
].join('\n')

describe('extractMain', () => {
  it('drops a leading cookie banner and starts at the article', () => {
    const page = [
      'We use cookies essential for this site to function well. Please click to help us improve',
      'its usefulness with additional cookies. Learn about our use of cookies in our [Privacy Policy](https://x/p).',
      '',
      ARTICLE,
    ].join('\n')

    const out = extractMain(page)
    expect(out).not.toMatch(/We use cookies/)
    expect(out).toContain('Andrej Karpathy popisuje')
  })

  it('drops leading navigation link runs', () => {
    const page = [
      '[Sitemap](https://medium.com/sitemap/sitemap.xml)',
      '',
      '[Open in app](https://play.google.com/store/apps/details?id=com.medium.reader)',
      '[Sign up](https://medium.com/signup)[Sign in](https://medium.com/signin)',
      '',
      ARTICLE,
    ].join('\n')

    const out = extractMain(page)
    expect(out).not.toContain('Sitemap')
    expect(out).not.toContain('Open in app')
    expect(out.startsWith('Andrej Karpathy popisuje')).toBe(true)
  })

  it('keeps a heading that introduces the content', () => {
    const page = ['[Home](/)[Blog](/blog)', '', '# Jak Karpathy používá LLM', '', ARTICLE].join('\n')
    const out = extractMain(page)
    expect(out).toContain('# Jak Karpathy používá LLM')
    expect(out).toContain('Andrej Karpathy popisuje')
  })

  it('leaves a page that starts with content untouched', () => {
    expect(extractMain(ARTICLE)).toBe(ARTICLE)
  })

  it('returns the original rather than nothing when no prose is found', () => {
    // A pure link farm has no content start; dropping everything would be worse than passing it on.
    const page = '[a](/a)\n[b](/b)\n[c](/c)'
    expect(extractMain(page)).toBe(page)
  })

  it('collapses runs of blank lines so the character budget carries text, not whitespace', () => {
    const out = extractMain(`${ARTICLE}\n\n\n\n\nDalší odstavec o tomtéž tématu a jeho důsledcích.`)
    expect(out).not.toMatch(/\n{3,}/)
    expect(out).toContain('Další odstavec')
  })

  it('is not fooled by a promo block whose markdown link wraps across lines', () => {
    // Shape taken from a real page that defeated a line-based version of this: the link text
    // spans several lines, so a per-line scan sees an unclosed bracket and reads it as prose.
    const page = [
      'We use cookies essential for this site to function well. [Privacy Policy](https://x/p).',
      '',
      "[India's Most Futuristic AI Conference Is Back – Bigger, Sharper, Bolder\\",
      '\\',
      '- d\\',
      ':- h\\',
      '\\',
      'Get Details](https://x/summit?utm_source=blog&utm_medium=desktop)',
      '',
      '# This is How Andrej Karpathy Uses LLMs',
      '',
      ARTICLE,
    ].join('\n')

    const out = extractMain(page)
    expect(out).not.toMatch(/We use cookies/)
    expect(out).not.toMatch(/Futuristic AI Conference/)
    expect(out.startsWith('# This is How Andrej Karpathy Uses LLMs')).toBe(true)
  })
})
