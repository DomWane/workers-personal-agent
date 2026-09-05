export interface ReminderPayload {
  text: string
}
export interface TaskPayload {
  prompt: string
}
/**
 * A web message already appended to history by the enqueue, waiting for its alarm to answer it.
 * The id travels with it because a second message can be sent while this one is still being
 * answered, and the turn then has to find its own message rather than take the last one.
 */
export interface WebMessagePayload {
  text: string
  id?: string
}
