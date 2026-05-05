import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useIdentity } from '~/hooks/use-identity'
import { AppHeader } from '~/components/identity/AppHeader'

export const Route = createFileRoute('/_identity')({
  component: IdentityLayout,
})

function IdentityLayout() {
  const { isIdentityCreated, resetDemo } = useIdentity()

  const handleReset = () => {
    if (confirm('This will clear your local identity and reset. Continue?')) {
      resetDemo()
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-white/20 overflow-x-hidden">
      <AppHeader showMenu={isIdentityCreated} onReset={handleReset} />
      <main className="flex-1 w-full flex flex-col">
        <Outlet />
      </main>
    </div>
  )
}
