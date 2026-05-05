import { Loader2, ArrowRight } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '~/components/ui/dialog'
import type { Bank } from '~/types/identity'

interface BankLoginModalProps {
  bank: Bank
  isOpen: boolean
  isLoading: boolean
  onOpenChange: (open: boolean) => void
  onConnect: () => void
  onChangeBank: () => void
}

export function BankLoginModal({
  bank,
  isOpen,
  isLoading,
  onOpenChange,
  onConnect,
  onChangeBank,
}: BankLoginModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          className="w-full bg-white text-black hover:bg-white/90 transition-all h-12 text-base font-medium group"
          data-testid="button-connect-idp"
        >
          <div
            className={`w-6 h-6 rounded-full ${bank.color} flex items-center justify-center text-white font-bold text-xs mr-2`}
          >
            {bank.name.charAt(0)}
          </div>
          Sign in to {bank.name}
          <ArrowRight className="w-4 h-4 ml-2 opacity-50 group-hover:translate-x-1 transition-transform" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-800 text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full ${bank.color} flex items-center justify-center text-white font-bold text-sm`}
            >
              {bank.name.charAt(0)}
            </div>
            {bank.name} Login
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Sign in to your {bank.name} account to verify your identity.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="bank-username" className="text-zinc-300">
              Username
            </Label>
            <Input
              id="bank-username"
              placeholder={`user@${bank.id}.com`}
              className="bg-zinc-800 border-zinc-700 text-white placeholder:text-zinc-500"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bank-password" className="text-zinc-300">
              Password
            </Label>
            <Input
              id="bank-password"
              type="password"
              value="password123"
              readOnly
              className="bg-zinc-800 border-zinc-700 text-white"
            />
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button
            onClick={onConnect}
            disabled={isLoading}
            className="w-full bg-white text-black hover:bg-white/90"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : 'Sign in & share data'}
          </Button>
          <Button
            variant="ghost"
            onClick={onChangeBank}
            className="w-full text-muted-foreground hover:text-white"
          >
            Choose a different bank
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
