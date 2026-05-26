import Owl from '@owlid/ui/components/Owl'
import { Loader2, Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@owlid/ui/components/ui/badge'

interface VerifierHeaderProps {
  serviceOnline: boolean | null
}

/** Sticky header that matches the holder app's chrome: small owl mark,
 *  wordmark, and a service-status pill on the right. */
export function VerifierHeader({ serviceOnline }: VerifierHeaderProps) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/5 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
        <div className="flex items-center gap-3">
          <div style={{ width: 28, height: 28 }}>
            <Owl size={28} />
          </div>
          <div className="flex flex-col leading-none">
            <span className="font-semibold tracking-tight text-sm uppercase">OwlID</span>
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Verifier
            </span>
          </div>
        </div>
        <Badge variant="outline" className="gap-1.5 border-white/10">
          {serviceOnline === null ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : serviceOnline ? (
            <Wifi className="w-3 h-3 text-emerald-400" />
          ) : (
            <WifiOff className="w-3 h-3 text-red-400" />
          )}
          <span className="text-xs">
            {serviceOnline === null ? 'Connecting…' : serviceOnline ? 'Online' : 'Offline'}
          </span>
        </Badge>
      </div>
    </header>
  )
}
