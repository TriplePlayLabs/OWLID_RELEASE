import { Menu, RotateCcw } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'

interface IdentityMenuProps {
  onReset: () => void
}

export function IdentityMenu({ onReset }: IdentityMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="fixed top-4 left-4 z-50 p-3 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-all duration-200 group"
          aria-label="Menu"
          data-testid="button-menu"
        >
          <Menu className="w-5 h-5 text-muted-foreground group-hover:text-white transition-colors" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="bg-zinc-950 border-white/10">
        <DropdownMenuItem
          onClick={onReset}
          className="text-red-400 focus:text-red-400 focus:bg-red-500/10 cursor-pointer"
        >
          <RotateCcw className="w-4 h-4 mr-2" />
          Reset & Clear Identity
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
