import { Link } from '@tanstack/react-router'
import { Menu, RotateCcw, History } from 'lucide-react'
import Owl from '~/components/Owl'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@owlid/ui/components/ui/dropdown-menu'

interface AppHeaderProps {
  showMenu: boolean
  onReset: () => void
}

// Sticky app chrome shown on every `_identity/*` route. Anchors the page
// at the top, exposes the menu when an identity exists, and gives the
// user a stable "home" affordance via the brand.
export function AppHeader({ showMenu, onReset }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/5 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
        <div className="flex items-center gap-3">
          {showMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Menu"
                  data-testid="button-menu"
                  className="p-2 -ml-2 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Menu className="w-5 h-5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-zinc-950 border-white/10">
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link to="/recent-proofs" className="flex items-center">
                    <History className="w-4 h-4 mr-2" />
                    Recent proofs
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-white/10" />
                <DropdownMenuItem
                  onClick={onReset}
                  className="text-red-400 focus:text-red-400 focus:bg-red-500/10 cursor-pointer"
                >
                  <RotateCcw className="w-4 h-4 mr-2" />
                  Reset & Clear Identity
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Link to="/" className="flex items-center gap-2 group">
            <Owl size={28} />
            <span className="font-semibold tracking-tight text-sm uppercase group-hover:text-white text-muted-foreground transition-colors">
              Owl ID
            </span>
          </Link>
        </div>
      </div>
    </header>
  )
}
