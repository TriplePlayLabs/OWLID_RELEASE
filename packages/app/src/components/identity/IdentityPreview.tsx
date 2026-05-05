import { FileJson, Loader2, CheckCircle } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import type { IdentityData } from '@owlid/sdk'

interface IdentityPreviewProps {
  identityData: IdentityData
  bankName: string
  isLoading: boolean
  onSign: () => void
}

export function IdentityPreview({
  identityData,
  bankName,
  isLoading,
  onSign,
}: IdentityPreviewProps) {
  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
      <div className="bg-secondary/30 rounded-lg p-4 border border-white/10 space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2 sticky top-0 bg-background/80 backdrop-blur-sm py-1">
          <FileJson className="w-4 h-4" />
          Verified details from {bankName}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          {Object.entries(identityData).map(([key, value]) => (
            <div key={key} className="flex flex-col">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                {key.replace(/([A-Z])/g, ' $1').trim()}
              </span>
              <span className="font-mono text-white truncate" title={String(value)}>
                {String(value)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Button
        onClick={onSign}
        disabled={isLoading}
        className="w-full bg-white text-black hover:bg-white/90 transition-all h-12 text-base font-medium"
        data-testid="button-sign-identity"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
        ) : (
          <CheckCircle className="w-4 h-4 mr-2" />
        )}
        Approve and create ID
      </Button>
    </div>
  )
}
