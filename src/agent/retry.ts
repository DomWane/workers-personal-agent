export const RETRY_DELAY_MS = 250

export async function retryOnce<T>(work: () => T | Promise<T>, onRetry?: (err: unknown) => void): Promise<T> {
  try {
    return await work()
  } catch (err) {
    onRetry?.(err)
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  return work()
}
