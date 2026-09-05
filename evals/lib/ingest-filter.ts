/**
 * What gets kept at export time, and it is deliberately only two things.
 *
 * The export is unfiltered by design: a vanished turn leaves request-level records and uncaught
 * exceptions behind, and deciding at export time that those are uninteresting cannot be undone
 * later. So this drops no *records* except ones belonging to a different application, and no
 * *fields* except the ones describing who made the call.
 *
 * Caller IP and geolocation answer no question this corpus asks. They are also the fields that
 * make the file dangerous to mishandle, which is a reason to never collect them rather than to
 * remember to strip them.
 */

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined
}

/** The export is account-wide; without this, other Workers' records land in this corpus. */
export function isFromService(event: unknown, service: string): boolean {
  const e = asObject(event)
  if (!e) {
    return false
  }
  const named = asObject(e.$metadata)?.service ?? asObject(e.$workers)?.scriptName
  return named === service
}

export function stripClientMetadata<T>(event: T): T {
  const e = asObject(event)
  if (!e) {
    return event
  }
  const workers = asObject(e.$workers)
  const inner = asObject(workers?.event)
  const request = asObject(inner?.request)
  if (!workers || !inner || !request) {
    return event
  }

  const { headers, cf, ...restOfRequest } = request
  const keptHeaders = asObject(headers)
  return {
    ...e,
    $workers: {
      ...workers,
      event: {
        ...inner,
        request: {
          ...restOfRequest,
          // `content-type` says how the body was framed; the rest identifies the caller.
          ...(keptHeaders?.['content-type'] ? { headers: { 'content-type': keptHeaders['content-type'] } } : {}),
        },
      },
    },
  } as T
}
