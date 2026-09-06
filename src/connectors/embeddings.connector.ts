export async function embedText(ai: Ai, text: string, budget?: { charge(n?: number): void }): Promise<number[]> {
  budget?.charge()
  const res = (await ai.run('@cf/baai/bge-m3', { text: [text], truncate_inputs: false })) as { data?: number[][] }
  return res.data?.[0] ?? []
}
