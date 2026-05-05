import { Suspense } from 'react'

import { modalManager } from './manager'
import { useModals } from './useModals'

export function ModalsPortal() {
  const modals = useModals()
  return (
    <>
      {modals
        .filter((m) => m.isOpen)
        .map(({ render: Component, ...modal }) => (
          <Suspense key={modal.key} fallback={null}>
            <Component
              args={modal.args}
              close={(resolveValue: unknown) => modalManager.close(modal.key, resolveValue)}
              isOpen={modal.isOpen}
            />
          </Suspense>
        ))}
    </>
  )
}
