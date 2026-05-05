// Promise that exposes its resolve/reject so callers can `await` an
// external completion (e.g. user closing a modal).
export class DeferredPromise<T> {
  promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}
