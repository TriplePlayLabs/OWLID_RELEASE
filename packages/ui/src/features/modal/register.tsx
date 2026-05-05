import type { DialogProps } from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

import type { RegisterModalOptions } from './manager'
import { modalManager } from './manager'

export interface ModalRenderProps<
  Args extends object = Record<string, unknown>,
  ResolvedValue = unknown,
> {
  isOpen: boolean
  args: Args
  close: (resolveValue?: ResolvedValue) => void
}

interface RegisterModalResult<
  Args extends object = Record<string, unknown>,
  ResolvedValue = unknown,
> {
  open: (args: Args) => Promise<ResolvedValue>
  close: (resolvedValue?: ResolvedValue) => void
  key: string
}

export function registerModal<
  Args extends object = Record<string, unknown>,
  ResolvedValue = unknown,
>(
  render: (props: ModalRenderProps<Args, ResolvedValue>) => ReactNode,
  options: RegisterModalOptions<Args> = {},
): RegisterModalResult<Args, ResolvedValue> {
  const key = modalManager.register<Args, ResolvedValue>(render, options)
  const open = (args: Args): Promise<ResolvedValue> =>
    modalManager.open<Args>(key, args) as Promise<ResolvedValue>
  const close = (resolvedValue?: ResolvedValue) => modalManager.close(key, resolvedValue)
  return { open, close, key }
}

export function toRadixDialogProps<
  Args extends object = Record<string, unknown>,
  ResolvedValue = unknown,
>(props: ModalRenderProps<Args, ResolvedValue>): DialogProps {
  return {
    open: props.isOpen,
    defaultOpen: props.isOpen,
    modal: true,
    onOpenChange: (open) => {
      if (!open) props.close()
    },
  }
}
