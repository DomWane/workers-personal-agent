/** A block needs this much link-free text to count as article prose. */
const PROSE_MIN_CHARS = 60
/** And that text must be this share of the block, so link farms cannot qualify by sheer length. */
const TEXT_RATIO_MIN = 0.3

const BOILERPLATE =
  /cookie|privacy policy|sign in|sign up|open in app|sitemap|subscribe|newsletter|all rights reserved|utm_source/i

/** `s` flag matters: real pages wrap a single link across several lines. */
const LINK_RE = /\[[^\]]*\]\([^)]*\)/gs

function plainText(block: string): string {
  return block
    .replace(LINK_RE, ' ')
    .replace(/[#*_>`~\\|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isHeading(block: string): boolean {
  return /^#{1,6}\s+\S/.test(block.trim())
}

function isProse(block: string): boolean {
  if (BOILERPLATE.test(block)) {
    return false
  }
  const text = plainText(block)
  if (text.length < PROSE_MIN_CHARS) {
    return false
  }
  return text.length / block.length >= TEXT_RATIO_MIN
}

/**
 * Page markdown arrives with the cookie banner, nav bar and promo strips first, and the result was
 * then cut to a character budget from the top — so the model received furniture, never the article,
 * and kept re-reading the same URL until the loop stalled.
 *
 * Neither provider fixes this upstream: Firecrawl's onlyMainContent is on by default and strips ~7%
 * while leaving the banner, and Cloudflare Browser Rendering has no equivalent option.
 *
 * Blocks, not lines: a real page wraps one markdown link across several lines, which makes a
 * line-based scan read navigation as prose.
 */
export function extractMain(markdown: string): string {
  const blocks = markdown.split(/\n\s*\n/)

  const first = blocks.findIndex(isProse)
  // No prose anywhere: passing the page through unchanged beats returning nothing.
  if (first === -1) {
    return markdown
  }

  // Keep a heading that introduces the content.
  const start = first > 0 && isHeading(blocks[first - 1]) ? first - 1 : first

  return blocks.slice(start).join('\n\n').trim()
}
