import { llmConfig } from './llm-config'
import type { Env, ModelRow } from '../types'

interface CloudflareModel {
  name?: string
  properties?: Array<{ property_id?: string; value?: unknown }>
}

interface OpenAiModel {
  id?: string
  supported_parameters?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
}

const PER_MILLION = 1_000_000

function price(value: unknown, scale: number): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n * scale : undefined
}

export function readModels(payload: unknown, catalogue: 'openai' | 'cloudflare'): ModelRow[] {
  const rows =
    catalogue === 'cloudflare' ? (payload as { result?: unknown[] })?.result : (payload as { data?: unknown[] })?.data
  if (!Array.isArray(rows)) {
    return []
  }
  const parse = catalogue === 'cloudflare' ? cloudflareRow : openAiRow
  return rows
    .map((row) => parse(row as never))
    .filter((row): row is ModelRow => row !== null)
    .sort(byUsability)
}

function cloudflareRow(row: CloudflareModel): ModelRow | null {
  if (typeof row?.name !== 'string') {
    return null
  }
  const prop = (id: string) => row.properties?.find((p) => p.property_id === id)?.value
  const rates = prop('price')
  const rate = (unit: string) =>
    Array.isArray(rates)
      ? (rates as Array<{ unit?: string; price?: unknown }>).find((r) => r.unit === `per M ${unit} tokens`)?.price
      : undefined
  return {
    id: row.name,
    tools: String(prop('function_calling')) === 'true',
    paid: prop('require_workers_paid') !== undefined,
    context: price(prop('context_window'), 1),
    priceIn: price(rate('input'), 1),
    priceOut: price(rate('output'), 1),
  }
}

function openAiRow(row: OpenAiModel): ModelRow | null {
  if (typeof row?.id !== 'string') {
    return null
  }
  return {
    id: row.id,
    tools: Array.isArray(row.supported_parameters) && row.supported_parameters.includes('tools'),
    paid: false,
    context: price(row.context_length, 1),
    priceIn: price(row.pricing?.prompt, PER_MILLION),
    priceOut: price(row.pricing?.completion, PER_MILLION),
  }
}

function byUsability(a: ModelRow, b: ModelRow): number {
  const rank = (m: ModelRow) => (m.tools && !m.paid ? 0 : 1)
  return rank(a) - rank(b) || a.id.localeCompare(b.id)
}

export async function contextWindowOf(
  env: Env,
  model: string,
  doFetch: typeof globalThis.fetch,
): Promise<number | undefined> {
  const cfg = llmConfig(env)
  const res = await doFetch(cfg.catalogueUrl, { headers: { authorization: `Bearer ${cfg.apiKey}` } })
  if (!res.ok) {
    return undefined
  }
  return readModels(await res.json(), cfg.catalogue).find((m) => m.id === model)?.context
}
