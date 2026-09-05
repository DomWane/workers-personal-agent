/**
 * One retry, for a write that must not be lost to a transient failure.
 *
 * Extracted rather than inlined because the interesting part is the policy, and the policy is
 * untestable where it is used: mocking `setState` on a live Durable Object breaks the test pool's
 * isolated storage before the assertion is reached.
 */
export const RETRY_DELAY_MS = 250

/**
 * Runs `work`, and on a throw waits and runs it once more. The second failure is rethrown: two
 * attempts distinguish a transient error from a broken one, and a third only delays the report.
 *
 * `onRetry` exists so the caller can say out loud that a first attempt failed. A retry that
 * succeeds silently hides the fault it survived, and the fault is the thing worth knowing about.
 */
export async function retryOnce<T>(work: () => T | Promise<T>, onRetry?: (err: unknown) => void): Promise<T> {
  try {
    return await work()
  } catch (err) {
    onRetry?.(err)
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  return work()
}
