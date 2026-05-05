import type { ReactNode } from 'react'
import { useCallback } from 'react'

import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog'
import type { ModalRenderProps } from '../register'
import { registerModal } from '../register'

export interface ConfirmModalOptions {
  title?: string
  description?: ReactNode
  confirmLabel?: string
  dismissLabel?: string
  variant?: 'default' | 'destructive'
}

export type ConfirmModalResult = 'confirmed' | 'dismissed' | 'closed'

function ConfirmModal({
  close,
  isOpen,
  args = {},
}: ModalRenderProps<ConfirmModalOptions, ConfirmModalResult>) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close('closed')
    },
    [close],
  )

  const {
    title = 'Confirm',
    description = 'Are you sure you want to continue?',
    confirmLabel = 'Confirm',
    dismissLabel = 'Cancel',
    variant = 'default',
  } = args

  return (
    <Dialog onOpenChange={handleOpenChange} open={isOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => close('dismissed')}>
            {dismissLabel}
          </Button>
          <Button variant={variant} onClick={() => close('confirmed')}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const CONFIRM_MODAL_KEY = 'owlid-confirm'

export const { open: openConfirmModal, close: closeConfirmModal } = registerModal<
  ConfirmModalOptions,
  ConfirmModalResult
>(ConfirmModal, {
  key: CONFIRM_MODAL_KEY,
  defaultArgs: {},
})
