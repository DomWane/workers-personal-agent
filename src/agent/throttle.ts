export function throttle<T>(ms: number, deliver: (value: T) => void) {
  let latest: T
  let timer: ReturnType<typeof setTimeout> | null = null
  const push = (value: T) => {
    latest = value
    timer ??= setTimeout(() => {
      timer = null
      deliver(latest)
    }, ms)
  }
  const cancel = () => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = null
  }
  return { push, cancel }
}
