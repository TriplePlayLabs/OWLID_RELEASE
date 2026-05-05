import { createFileRoute, Outlet } from '@tanstack/react-router'
import { IdentityProvider, useIdentityContext } from '~/contexts/identity-context'
import { IdentityMenu } from '~/components/identity/IdentityMenu'

export const Route = createFileRoute('/_identity')({
  component: IdentityLayout,
})

function IdentityLayout() {
  return (
    <IdentityProvider>
      <IdentityLayoutContent />
    </IdentityProvider>
  )
}

function IdentityLayoutContent() {
  const { isIdentityCreated, resetDemo } = useIdentityContext()

  const handleReset = () => {
    if (confirm('This will clear your local identity and reset. Continue?')) {
      resetDemo()
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-white/20 overflow-x-hidden relative">
      {isIdentityCreated && <IdentityMenu onReset={handleReset} />}

      <div className="w-full p-4 md:p-12 flex flex-col justify-center relative z-10">
        <Outlet />
      </div>
    </div>
  )
}
