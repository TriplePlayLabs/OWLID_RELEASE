import type { ReactNode } from 'react'
import { DeferredPromise } from '../../lib/deferred'
import type { ModalRenderProps } from './register'

export interface RegisteredModal<
  Args extends object = Record<string, unknown>,
  ResolvedValue = unknown,
> {
  key: string
  isOpen: boolean
  render: (props: ModalRenderProps<Args, ResolvedValue>) => ReactNode
  args: Args
  onClose?: (resolveValue?: ResolvedValue) => void
}

export interface RegisterModalOptions<Args extends object = Record<string, unknown>> {
  key?: string
  defaultArgs?: Args
}

export class ModalManager {
  #subscriptions: Set<() => void> = new Set()
  #nextKey = 0
  modals: RegisteredModal[] = []
  #modalPromises = new Map<string, DeferredPromise<unknown>>()

  #notify(): void {
    this.modals = this.modals.slice()
    for (const fn of this.#subscriptions) fn()
  }

  subscribe(fn: () => void): () => void {
    this.#subscriptions.add(fn)
    return () => this.#subscriptions.delete(fn)
  }

  open<Args extends object = Record<string, unknown>, ResolvedValue = unknown>(
    key: string,
    args: Args,
  ): Promise<ResolvedValue> {
    const modal = this.modals.find((m) => m.key === key)
    if (!modal) throw new Error(`Modal with key ${key} not found`)
    const modalPromise = new DeferredPromise<unknown>()
    this.#modalPromises.set(key, modalPromise)
    const { onClose } = modal
    modal.onClose = (resolvedValue: unknown): void => {
      modal.isOpen = false
      this.#notify()
      onClose?.(resolvedValue)
      modalPromise.resolve(resolvedValue)
      this.#modalPromises.delete(key)
    }
    modal.isOpen = true
    modal.args = args as Record<string, unknown>
    this.#notify()
    return modalPromise.promise as Promise<ResolvedValue>
  }

  close<ResolvedValue = unknown>(key: string, resolvedValue?: ResolvedValue): void {
    const modal = this.modals.find((m) => m.key === key)
    modal?.onClose?.(resolvedValue)
  }

  register<Args extends object = Record<string, unknown>, ResolvedValue = unknown>(
    render: RegisteredModal<Args, ResolvedValue>['render'],
    options: RegisterModalOptions<Args> = {},
  ): string {
    let { key } = options
    if (key && this.modals.some((m) => m.key === key)) {
      console.warn(`Modal with key ${key} already exists`)
    }
    if (this.modals.some((m) => m.render === render)) {
      console.warn(`Modal with render function ${render} already exists`)
    }

    if (!key) {
      this.#nextKey += 1
      key = `modal-${this.#nextKey}`
    }

    this.modals.push({
      key,
      isOpen: false,
      render,
      args: options.defaultArgs,
    } as RegisteredModal)

    this.#notify()
    return key
  }
}

export const modalManager = new ModalManager()
