/** undici types an intercepted body `unknown`, and `String()` on a non-string asserts against the
 *  literal `[object Object]` — a fixture that can never match rather than one that fails. */
export function requestBody(opts: unknown): string {
  const body = (opts as { body?: unknown }).body
  return typeof body === 'string' ? body : ''
}
