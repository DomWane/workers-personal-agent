/** One entry of the /api/models catalogue. */
export interface ModelRow {
  id: string
  /** The agent is a tool loop, so a model without tools is unusable rather than merely weaker. */
  tools: boolean
  paid: boolean
  context?: number
  /** USD per million tokens, in and out. Both catalogues carry it in their own unit — OpenRouter
   *  per token, Cloudflare per million — and it is normalised here so the picker can compare. */
  priceIn?: number
  priceOut?: number
}
