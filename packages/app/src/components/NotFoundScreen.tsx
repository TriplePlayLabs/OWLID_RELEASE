import { Link } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'

/** Real 404 view — a perpetual LoadingScreen on a bad URL reads as a
 *  hang, not a missing page. */
export function NotFoundScreen() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-6 text-center">
      <Compass className="w-10 h-10 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">This address doesn't exist in the wallet.</p>
      </div>
      <Button asChild variant="outline">
        <Link to="/">Go to your wallet</Link>
      </Button>
    </div>
  )
}
