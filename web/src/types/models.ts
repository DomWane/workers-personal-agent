export interface ModelRow {
  id: string
  tools: boolean
  paid: boolean
  context?: number
  /** USD per million tokens, normalised by the Worker from whichever unit the catalogue used. */
  priceIn?: number
  priceOut?: number
}
