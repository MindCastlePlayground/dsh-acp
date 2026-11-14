// Minimal async queue: producers push, one consumer shifts, and closing wakes
// the consumer even when nothing was produced.
//
// The ACP stream needs this shape because ACP delivers turn content as
// notifications while the `session/prompt` request is still in flight; the
// generator must interleave "await the next notification" with "await the
// prompt result" without polling.

export const QUEUE_END = Symbol('queue-end')

export class AsyncQueue {
  #items = []
  #waiters = []
  #closed = false
  #failure

  get size() {
    return this.#items.length
  }

  get closed() {
    return this.#closed
  }

  push(item) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(item)
      return
    }
    this.#items.push(item)
  }

  /** Close the queue after its buffered items, optionally reporting a failure. */
  close(failure) {
    this.#closed = true
    this.#failure = failure
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#items.length > 0) waiter.resolve(this.#items.shift())
      else waiter.resolve(QUEUE_END)
    }
  }

  /** Next item, or the end marker once the producer closed the queue. */
  shift() {
    if (this.#items.length > 0) return Promise.resolve(this.#items.shift())
    if (this.#closed) return Promise.resolve(QUEUE_END)
    return new Promise((resolve) => {
      this.#waiters.push({ resolve })
    })
  }
}
