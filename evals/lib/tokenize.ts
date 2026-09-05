/**
 * Diacritics are folded because Czech is routinely typed without them, and a retrieval
 * eval that treats "kava" and "káva" as unrelated would measure keyboard habits.
 */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks, escaped so the source survives copy/paste
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
}
