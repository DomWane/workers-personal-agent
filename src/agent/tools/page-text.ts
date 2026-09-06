const PROSE_MIN_CHARS = 60
const TEXT_RATIO_MIN = 0.3

const BOILERPLATE =
  /cookie|privacy policy|sign in|sign up|open in app|sitemap|subscribe|newsletter|all rights reserved|utm_source/i

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

export function extractMain(markdown: string): string {
  const blocks = markdown.split(/\n\s*\n/)

  const first = blocks.findIndex(isProse)
  if (first === -1) {
    return markdown
  }

  const start = first > 0 && isHeading(blocks[first - 1]) ? first - 1 : first

  return blocks.slice(start).join('\n\n').trim()
}
