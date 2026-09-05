import { existsSync, readFileSync } from 'node:fs'

/**
 * Every producer in this pipeline appends per record, so a process killed with Ctrl-C leaves a
 * half-written last line. A raw JSON.parse over the file turns that normal interruption into a
 * SyntaxError at the next run's startup, which is why this lives in one place rather than being
 * reimplemented per entrypoint.
 *
 * `required` separates the two cases the callers actually have: a resume file that is simply
 * not there yet, and a pipeline input whose absence should be loud rather than an empty run.
 */
export function readJsonLines<T>(path: string, opts: { required?: boolean } = {}): T[] {
  if (!existsSync(path)) {
    if (opts.required) {
      throw new Error(`missing input file: ${path}`)
    }
    return []
  }
  const out: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) {
      continue
    }
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // partially-written trailing line from an interrupted append; ignore it
    }
  }
  return out
}
