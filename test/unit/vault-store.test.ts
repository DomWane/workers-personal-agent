import { describe, expect, it, vi } from 'vitest'
import { slugify } from '../../src/agent/memory/vault-format'
import { VaultStore, sanitize } from '../../src/agent/memory/vault-store'
import type { VaultBackend } from '../../src/agent/memory/vault-store'

function fakeBackend(files: Record<string, { content: string; sha: string; meta?: Record<string, string> }>) {
  return {
    getFile: vi.fn(async (path: string) => files[path] ?? null),
    putFile: vi.fn(
      async (path: string, content: string, _msg: string, _sha?: string, meta?: Record<string, string>) => {
        files[path] = { content, sha: `sha-${path}`, ...(meta ? { meta } : {}) }
      },
    ),
    listDir: vi.fn(async (path: string) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map((p) => ({ name: p.slice(path.length + 1), sha: files[p].sha, meta: files[p].meta })),
    ),
    deleteFile: vi.fn(async (path: string) => {
      delete files[path]
    }),
  } as unknown as VaultBackend & Record<'getFile' | 'putFile' | 'listDir' | 'deleteFile', ReturnType<typeof vi.fn>>
}

describe('slugify', () => {
  it('lowercases, strips diacritics-unsafe chars, hyphenates', () => {
    expect(slugify('Sam Likes Tea!')).toBe('sam-likes-tea')
    expect(slugify('  --Weird__ input  ')).toBe('weird-input')
  })

  it('strips a trailing ISO date so date-suffixed names update in place', () => {
    expect(slugify('open follow-ups 2026-07-07')).toBe('open-follow-ups')
    expect(slugify('open-follow-ups-2026-07-07')).toBe('open-follow-ups')
    // a date in the middle is left alone — only a trailing one is a slug artifact
    expect(slugify('2026-07-07 retro notes')).toBe('2026-07-07-retro-notes')
  })
})

const SOURCE = { thread: 't-1', turn: 'm7', at: 1_700_000_000_000 }

describe('VaultStore.save', () => {
  it('creates the memory file with frontmatter and appends to a new index', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    const backend = fakeBackend(files)
    const store = new VaultStore(backend, 'agent', '2026-07-06')

    await store.save({
      name: 'Sam likes tea',
      description: 'prefers tea over coffee',
      content: 'Green tea, no sugar.',
      source: SOURCE,
    })

    const mem = files['agent/memory/sam-likes-tea.md']
    // The pointer rides in the frontmatter, flat, because the parser is one `key: value` a line.
    expect(mem.content).toBe(
      '---\nname: Sam likes tea\ndescription: prefers tea over coffee\ndate: 2026-07-06\n' +
        'source_thread: t-1\nsource_turn: m7\nsource_at: 1700000000000\n---\n\nGreen tea, no sugar.\n',
    )
    expect(files['agent/MEMORY.md'].content).toBe('# Agent memory\n\n- sam-likes-tea — prefers tea over coffee\n')
  })

  it('updates an existing file with its sha and upserts the index line', async () => {
    const files = {
      'agent/memory/sam-likes-tea.md': { content: 'old', sha: 'old-sha' },
      'agent/MEMORY.md': {
        content: '# Agent memory\n\n- sam-likes-tea — old description\n- other — keep me\n',
        sha: 'idx-sha',
      },
    }
    const backend = fakeBackend(files)
    await new VaultStore(backend, 'agent', '2026-07-06').save({
      name: 'Sam likes tea',
      description: 'new description',
      content: 'Updated.',
      source: SOURCE,
    })

    // file update carried the old sha
    expect(backend.putFile).toHaveBeenCalledWith(
      'agent/memory/sam-likes-tea.md',
      expect.any(String),
      expect.any(String),
      'old-sha',
    )
    expect(files['agent/MEMORY.md'].content).toBe(
      '# Agent memory\n\n- sam-likes-tea — new description\n- other — keep me\n',
    )
  })

  it('collapses newlines in name/description so frontmatter and the index stay single-line', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-06')

    await store.save({
      name: 'Sam likes tea',
      description: 'prefers tea\nover coffee\nalways',
      content: 'c',
      source: SOURCE,
    })

    expect(files['agent/MEMORY.md'].content.trimEnd().split('\n')).toHaveLength(3) // header, blank, one index line
    expect(files['agent/MEMORY.md'].content).toContain('- sam-likes-tea — prefers tea over coffee always\n')
    expect(files['agent/memory/sam-likes-tea.md'].content).toContain('description: prefers tea over coffee always\n')
  })

  it('falls back to slug "untitled" when the name has no sluggable characters', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-06')

    await store.save({ name: '!!!', description: 'd', content: 'c', source: SOURCE })

    expect(files['agent/memory/untitled.md']).toBeDefined()
  })
})

describe('VaultStore.search', () => {
  const files = {
    'agent/MEMORY.md': {
      content:
        '# Agent memory\n\n- sam-likes-tea — prefers tea over coffee\n- vault-repo — where the obsidian vault lives\n',
      sha: 's',
    },
    'agent/memory/sam-likes-tea.md': {
      content: '---\nname: Sam likes tea\ndescription: prefers tea over coffee\ndate: 2026-07-06\n---\n\nGreen tea.\n',
      sha: 's1',
    },
  }

  it('matches on description words and returns parsed entries', async () => {
    const store = new VaultStore(fakeBackend({ ...files }), 'agent')
    const results = await store.search('what coffee does he drink')
    expect(results).toEqual([{ name: 'Sam likes tea', description: 'prefers tea over coffee', content: 'Green tea.' }])
  })

  it('returns empty when nothing matches or index is missing', async () => {
    await expect(new VaultStore(fakeBackend({ ...files }), 'agent').search('zzz qqq')).resolves.toEqual([])
    await expect(new VaultStore(fakeBackend({}), 'agent').search('tea')).resolves.toEqual([])
  })
})

describe('VaultStore.list', () => {
  it('returns the index markdown, or a hint when empty', async () => {
    const store = new VaultStore(
      fakeBackend({ 'agent/MEMORY.md': { content: '# Agent memory\n\n- a — b\n', sha: 's' } }),
      'agent',
    )
    await expect(store.list()).resolves.toContain('- a — b')
    await expect(new VaultStore(fakeBackend({}), 'agent').list()).resolves.toBe('(no memories saved yet)')
  })
})

describe('sanitize', () => {
  it('strips invisible and control unicode but keeps newlines and tabs', () => {
    expect(sanitize('a​b‮c﻿de')).toBe('abcde')
    expect(sanitize('line1\nline2\ttab')).toBe('line1\nline2\ttab')
  })
})

describe('VaultStore.save hygiene', () => {
  it('strips invisible unicode from name, description and content before writing', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-07')

    await store.save({
      name: 'evil​ memory',
      description: 'desc‮ here',
      content: 'body﻿ text',
      source: SOURCE,
    })

    const mem = files['agent/memory/evil-memory.md']
    expect(mem.content).not.toMatch(/[​‮﻿]/)
    expect(mem.content).toContain('name: evil memory')
    expect(mem.content).toContain('body text')
  })
})

describe('VaultStore sessions', () => {
  it('search also surfaces sessions matched by filename, newest first', async () => {
    const files = {
      'agent/sessions/2026-07-06-phase-planning.md': { content: '# Phase planning\n\nplanned things', sha: 's' },
    }
    const store = new VaultStore(fakeBackend(files), 'agent')

    const results = await store.search('planning')

    expect(results).toEqual([
      {
        name: '2026-07-06-phase-planning',
        description: 'past session summary',
        content: '# Phase planning\n\nplanned things',
      },
    ])
  })
})

describe('VaultStore user profile', () => {
  it('getUserProfile returns empty string when USER.md is missing', async () => {
    await expect(new VaultStore(fakeBackend({}), 'agent').getUserProfile()).resolves.toBe('')
  })

  it('add appends a line and reports usage', async () => {
    const files = { 'agent/USER.md': { content: '- Sam likes tea\n', sha: 'p1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')

    const out = await store.updateUserProfile('add', '- Works at Acme')

    expect(out).toBe(`profile updated (${'- Sam likes tea\n- Works at Acme'.length}/1300 chars)`)
    expect(files['agent/USER.md'].content).toBe('- Sam likes tea\n- Works at Acme\n')
  })

  it('replace swaps exact text and remove deletes it; both error when text is absent', async () => {
    const files = { 'agent/USER.md': { content: '- Sam likes tea\n- Old fact\n', sha: 'p1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')

    await store.updateUserProfile('replace', '- Old fact', '- New fact')
    expect(files['agent/USER.md'].content).toBe('- Sam likes tea\n- New fact\n')

    await store.updateUserProfile('remove', '- New fact')
    expect(files['agent/USER.md'].content).toBe('- Sam likes tea\n')

    await expect(store.updateUserProfile('remove', '- never existed')).resolves.toMatch(/^error: text not found/)
  })

  it('rejects writes past the 1300-char cap with a consolidation hint, leaving the file untouched', async () => {
    const big = 'x'.repeat(1290)
    const files = { 'agent/USER.md': { content: `${big}\n`, sha: 'p1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')

    const out = await store.updateUserProfile('add', 'this line pushes it past the cap')

    expect(out).toMatch(/^error: profile would be \d+\/1300 chars/)
    expect(files['agent/USER.md'].content).toBe(`${big}\n`)
  })

  it('sanitizes invisible unicode in profile writes', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    const store = new VaultStore(fakeBackend(files), 'agent')

    await store.updateUserProfile('add', '- fact​ here')

    expect(files['agent/USER.md'].content).toBe('- fact here\n')
  })
})

const SKILL_FILE =
  '---\nname: Daily digest\ndescription: how to build the daily digest\ndate: 2026-06-01\nuse_count: 2\nlast_used: 2026-06-20\n---\n\n## When to Use\nDigest requests.\n'

describe('VaultStore skills', () => {
  it('saves a new skill with zeroed counters', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-07')

    const out = await store.saveSkill({
      name: 'Daily digest',
      description: 'how to build the daily digest',
      content: '## When to Use\nDigest requests.',
    })

    expect(out).toBe('saved skill "daily-digest"')
    expect(files['agent/skills/daily-digest.md'].content).toBe(
      '---\nname: Daily digest\ndescription: how to build the daily digest\ndate: 2026-07-07\nuse_count: 0\n---\n\n## When to Use\nDigest requests.\n',
    )
  })

  it('preserves use_count, last_used, pinned and creation date on update', async () => {
    const files = {
      'agent/skills/daily-digest.md': {
        content: SKILL_FILE.replace('---\n\n', 'pinned: true\n---\n\n'),
        sha: 'sk1',
      },
    }
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-07')

    await store.saveSkill({ name: 'Daily digest', description: 'updated description', content: 'new body' })

    const c = files['agent/skills/daily-digest.md'].content
    expect(c).toContain('description: updated description')
    expect(c).toContain('date: 2026-06-01')
    expect(c).toContain('use_count: 2')
    expect(c).toContain('last_used: 2026-06-20')
    expect(c).toContain('pinned: true')
    expect(c).toContain('new body')
  })

  it('listSkills parses frontmatter from every skill file', async () => {
    const files = {
      'agent/skills/daily-digest.md': { content: SKILL_FILE, sha: 's1' },
      'agent/skills/archive': { content: '', sha: 'dir' }, // fakeBackend listDir only matches direct children ending .md via filter below
    }
    const store = new VaultStore(fakeBackend(files), 'agent')

    const skills = await store.listSkills()

    expect(skills).toEqual([
      {
        slug: 'daily-digest',
        name: 'Daily digest',
        description: 'how to build the daily digest',
        useCount: 2,
        lastUsed: '2026-06-20',
        date: '2026-06-01',
        pinned: false,
      },
    ])
  })

  it('readSkill returns the body and stamps use_count/last_used', async () => {
    const files = { 'agent/skills/daily-digest.md': { content: SKILL_FILE, sha: 's1' } }
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-07')

    const skill = await store.readSkill('Daily Digest')

    expect(skill?.content).toBe('## When to Use\nDigest requests.')
    expect(skill?.useCount).toBe(2) // returns pre-stamp value; stamp is telemetry
    const stamped = files['agent/skills/daily-digest.md'].content
    expect(stamped).toContain('use_count: 3')
    expect(stamped).toContain('last_used: 2026-07-07')
  })

  it('readSkill returns null for unknown skills and survives stamp failures', async () => {
    const files = { 'agent/skills/daily-digest.md': { content: SKILL_FILE, sha: 's1' } }
    const backend = fakeBackend(files)
    backend.putFile.mockRejectedValueOnce(new Error('vault down'))
    const store = new VaultStore(backend, 'agent', '2026-07-07')

    await expect(store.readSkill('nope')).resolves.toBeNull()
    await expect(store.readSkill('daily-digest')).resolves.toMatchObject({ slug: 'daily-digest' })
  })

  it('archiveSkill copies to archive/ then deletes the original', async () => {
    const files: Record<string, { content: string; sha: string }> = {
      'agent/skills/daily-digest.md': { content: SKILL_FILE, sha: 's1' },
    }
    const store = new VaultStore(fakeBackend(files), 'agent')

    const out = await store.archiveSkill('daily-digest')

    expect(out).toBe('archived skill "daily-digest"')
    expect(files['agent/skills/archive/daily-digest.md'].content).toBe(SKILL_FILE)
    expect(files['agent/skills/daily-digest.md']).toBeUndefined()

    await expect(store.archiveSkill('missing')).resolves.toBe('error: skill not found: missing')
  })
})

describe('VaultStore.archiveMemory', () => {
  it('copies to archive/, deletes the original, and drops the index line', async () => {
    const files: Record<string, { content: string; sha: string }> = {
      'agent/memory/old-note.md': {
        content: '---\nname: Old note\ndescription: d\ndate: 2026-07-01\n---\n\nbody\n',
        sha: 'm1',
      },
      'agent/MEMORY.md': { content: '# Agent memory\n\n- old-note — d\n- keep-me — stays\n', sha: 'idx' },
    }
    const store = new VaultStore(fakeBackend(files), 'agent', '2026-07-11')

    const out = await store.archiveMemory('old-note')

    expect(out).toBe('archived memory "old-note"')
    expect(files['agent/memory/archive/old-note.md'].content).toContain('body')
    expect(files['agent/memory/old-note.md']).toBeUndefined()
    expect(files['agent/MEMORY.md'].content).toBe('# Agent memory\n\n- keep-me — stays\n')
  })

  it('reports not found without touching anything', async () => {
    const store = new VaultStore(fakeBackend({}), 'agent')
    await expect(store.archiveMemory('nope')).resolves.toBe('error: memory not found: nope')
  })
})

describe('the skill index comes from object metadata', () => {
  it('saveSkill writes the frontmatter as metadata, and listSkills reads it without opening files', async () => {
    // Mutation check: drop the `e.meta?.name` branch in `listSkills` and getFile is called once.
    const vault = fakeBackend({})
    const store = new VaultStore(vault, 'agent', '2026-09-07')
    await store.saveSkill({ name: 'Daily digest', description: 'AI news', content: 'body' })
    expect(vault.putFile.mock.calls[0][4]).toMatchObject({ name: 'Daily digest', description: 'AI news' })

    vault.getFile.mockClear()
    const skills = await store.listSkills()
    expect(skills).toMatchObject([{ slug: 'daily-digest', description: 'AI news', useCount: 0 }])
    expect(vault.getFile).not.toHaveBeenCalled()
  })

  it('opens a skill file that carries no metadata, so a hand-written skill is still listed', async () => {
    const vault = fakeBackend({ 'agent/skills/daily-digest.md': { content: SKILL_FILE, sha: 's1' } })
    const skills = await new VaultStore(vault, 'agent').listSkills()
    expect(skills).toMatchObject([{ slug: 'daily-digest', name: 'Daily digest' }])
    expect(vault.getFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the metadata current through a use stamp', async () => {
    const vault = fakeBackend({})
    const store = new VaultStore(vault, 'agent', '2026-09-07')
    await store.saveSkill({ name: 'Daily digest', description: 'AI news', content: 'body' })
    await store.readSkill('daily-digest')
    expect((await store.listSkills())[0]).toMatchObject({ useCount: 1, lastUsed: '2026-09-07' })
  })
})

describe('VaultStore.listSkills truncation', () => {
  it('logs when it drops skills past the cap instead of hiding them', async () => {
    const files: Record<string, { content: string; sha: string }> = {}
    for (let i = 0; i < 32; i++) {
      files[`agent/skills/s${i}.md`] = {
        content: `---\nname: S${i}\ndescription: d\ndate: 2026-07-01\n---\n\nbody\n`,
        sha: `k${i}`,
      }
    }
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logged.push(String(m)))
    try {
      const skills = await new VaultStore(fakeBackend(files), 'agent').listSkills()
      expect(skills).toHaveLength(30)
    } finally {
      spy.mockRestore()
    }
    expect(logged.join('\n')).toContain('"stage":"skills-truncated"')
    expect(logged.join('\n')).toContain('"total":32')
  })

  it('says nothing when everything fits', async () => {
    const files = {
      'agent/skills/one.md': { content: '---\nname: One\ndescription: d\ndate: 2026-07-01\n---\n\nb\n', sha: 'k' },
    }
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logged.push(String(m)))
    try {
      await new VaultStore(fakeBackend(files), 'agent').listSkills()
    } finally {
      spy.mockRestore()
    }
    expect(logged.join('\n')).not.toContain('skills-truncated')
  })
})

describe('VaultStore.resolveMemorySlug', () => {
  // The real regression: slugify trims a trailing date, so archiving "notes-2026-07-07"
  // used to resolve to "notes" and archive a different, live memory. It happened to
  // `open-follow-ups` in the production vault.
  const dated = 'agent/memory/notes-2026-07-07.md'
  const undatedContent = { content: '---\nname: notes\ndescription: live\ndate: 2026-07-10\n---\n\nkeep\n', sha: 'u' }
  const datedContent = {
    content: '---\nname: notes-2026-07-07\ndescription: superseded\ndate: 2026-07-07\n---\n\ndrop\n',
    sha: 'd',
  }

  it('prefers an existing dated slug over the trimmed one', async () => {
    const store = new VaultStore(
      fakeBackend({ [dated]: datedContent, 'agent/memory/notes.md': undatedContent }),
      'agent',
    )
    await expect(store.resolveMemorySlug('notes-2026-07-07')).resolves.toBe('notes-2026-07-07')
  })

  it('falls back to the trimmed slug when only that exists', async () => {
    const store = new VaultStore(fakeBackend({ 'agent/memory/notes.md': undatedContent }), 'agent')
    await expect(store.resolveMemorySlug('notes 2026-07-07')).resolves.toBe('notes')
  })

  it('returns the canonical slug when nothing exists, so the error names it', async () => {
    const store = new VaultStore(fakeBackend({}), 'agent')
    await expect(store.resolveMemorySlug('Nothing Here 2026-07-07')).resolves.toBe('nothing-here')
  })

  it('archives the dated memory and leaves the undated one alone', async () => {
    const files: Record<string, { content: string; sha: string }> = {
      [dated]: datedContent,
      'agent/memory/notes.md': undatedContent,
      'agent/MEMORY.md': { content: '# Agent memory\n\n- notes-2026-07-07 — superseded\n- notes — live\n', sha: 'i' },
    }
    const store = new VaultStore(fakeBackend(files), 'agent')

    await store.archiveMemory(await store.resolveMemorySlug('notes-2026-07-07'))

    expect(files[dated]).toBeUndefined()
    expect(files['agent/memory/notes.md']).toBeDefined()
    expect(files['agent/MEMORY.md'].content).toBe('# Agent memory\n\n- notes — live\n')
  })
})

describe('VaultStore.readEntry / indexManifest', () => {
  const files = {
    'agent/MEMORY.md': { content: '# Agent memory\n\n- sam-likes-tea — prefers tea\n', sha: 'i' },
    'agent/memory/sam-likes-tea.md': {
      content: '---\nname: Sam likes tea\ndescription: prefers tea\ndate: 2026-07-01\n---\n\nGreen tea.\n',
      sha: 'm',
    },
    'agent/sessions/2026-07-06-trip.md': { content: '# Trip\n\nWent to Vienna.', sha: 's' },
    'agent/research/2026-08-08-rag-eval.md': { content: '# RAG eval\n\nWhat we found.', sha: 'r' },
  }

  it('readEntry parses a memory and a session', async () => {
    const store = new VaultStore(fakeBackend({ ...files }), 'agent')
    expect((await store.readEntry('memory', 'sam-likes-tea'))?.name).toBe('Sam likes tea')
    expect((await store.readEntry('session', '2026-07-06-trip'))?.content).toContain('Vienna')
    expect(await store.readEntry('memory', 'ghost')).toBeNull()
  })

  it('indexManifest lists memories and sessions with their fingerprints, without reading them', async () => {
    const store = new VaultStore(fakeBackend({ ...files }), 'agent')
    const manifest = await store.indexManifest()
    expect(manifest).toEqual([
      { kind: 'memory', slug: 'sam-likes-tea', sha: 'm' },
      { kind: 'session', slug: '2026-07-06-trip', sha: 's' },
      { kind: 'research', slug: '2026-08-08-rag-eval', sha: 'r' },
    ])
  })

  it('readEntry reads a saved research report', async () => {
    const store = new VaultStore(fakeBackend({ ...files }), 'agent')
    expect((await store.readEntry('research', '2026-08-08-rag-eval'))?.content).toContain('What we found')
  })
})

describe('VaultStore.saveResearch', () => {
  it('writes a dated report and returns its slug', async () => {
    const vault = fakeBackend({})
    const slug = await new VaultStore(vault, 'agent').saveResearch('Jak se měří kvalita RAG', 'Findings.')

    // slugify drops accented characters rather than transliterating them, so a Czech topic loses
    // letters. Shared with memories and sessions; changing it would re-slug the existing vault.
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-jak-se-m-kvalita-rag$/)
    expect(vault.putFile).toHaveBeenCalledWith(
      `agent/research/${slug}.md`,
      expect.stringContaining('Findings.'),
      expect.any(String),
    )
  })

  it('keeps a second report on the same topic instead of overwriting the first', async () => {
    // A run costs ten minutes and a hundred requests; a second one on the same topic is another
    // run, not a correction of the first, so it does not take its place.
    const vault = fakeBackend({})
    const store = new VaultStore(vault, 'agent')
    const first = await store.saveResearch('RAG eval', 'First run.')
    const second = await store.saveResearch('RAG eval', 'Second run.')

    expect(second).not.toBe(first)
  })
})

describe('VaultStore agent notes', () => {
  it('getAgentNotes returns empty string when AGENT.md is missing', async () => {
    await expect(new VaultStore(fakeBackend({}), 'agent').getAgentNotes()).resolves.toBe('')
  })

  it('add appends a line and reports usage against the 2000-char cap', async () => {
    const files = { 'agent/AGENT.md': { content: '- vault repo is owner/vault\n', sha: 'a1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')
    const out = await store.updateAgentNotes('add', '- Sam works in Czech')
    expect(out).toBe(`profile updated (${'- vault repo is owner/vault\n- Sam works in Czech'.length}/2000 chars)`)
    expect(files['agent/AGENT.md'].content).toBe('- vault repo is owner/vault\n- Sam works in Czech\n')
  })

  it('rejects a write past the 2000-char cap, leaving the file untouched', async () => {
    const big = 'x'.repeat(1990)
    const files = { 'agent/AGENT.md': { content: `${big}\n`, sha: 'a1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')
    const out = await store.updateAgentNotes('add', 'this line pushes it past the cap')
    expect(out).toMatch(/^error: profile would be \d+\/2000 chars/)
    expect(files['agent/AGENT.md'].content).toBe(`${big}\n`)
  })

  it('existing updateUserProfile still works after the refactor (1300 cap)', async () => {
    const files = { 'agent/USER.md': { content: '- Sam likes tea\n', sha: 'p1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')
    const out = await store.updateUserProfile('add', '- Works at Acme')
    expect(out).toBe(`profile updated (${'- Sam likes tea\n- Works at Acme'.length}/1300 chars)`)
  })
})

describe('bounded write recovery', () => {
  it('returns the live content when replace cannot find its text', async () => {
    const files = { 'agent/USER.md': { content: '- Sam likes tea\n- Works at ACME\n', sha: 'p1' } }
    const store = new VaultStore(fakeBackend(files), 'agent')

    // The caller's copy is stale: it still believes an already-overwritten line is present.
    const out = await store.updateUserProfile('replace', '- Works at OLDCORP', '- Works at ACME')
    expect(out).toMatch(/^error: text not found/)
    expect(out).toContain('- Sam likes tea')
    expect(out).toContain('- Works at ACME')
    expect(files['agent/USER.md'].content).toBe('- Sam likes tea\n- Works at ACME\n')
  })
})
