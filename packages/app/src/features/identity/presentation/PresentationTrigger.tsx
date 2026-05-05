import { Fingerprint } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { openPresentationModal } from './PresentationModal'

export function PresentationTrigger() {
  return (
    <Button
      onClick={() => openPresentationModal({})}
      className="w-full bg-white text-black hover:bg-white/90 transition-all h-11 text-sm font-medium"
      data-testid="button-present-id"
    >
      <Fingerprint className="w-4 h-4 mr-2" />
      Present ID
    </Button>
  )
}
