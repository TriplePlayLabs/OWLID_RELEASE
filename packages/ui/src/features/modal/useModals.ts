import { useCallback, useSyncExternalStore } from 'react'

import type { RegisteredModal } from './manager'
import { modalManager } from './manager'

export function useModals(): RegisteredModal[] {
  const subscribe = useCallback((s: () => void) => modalManager.subscribe(s), [])
  const getSnapshot = useCallback(() => modalManager.modals, [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
