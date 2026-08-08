/**
 * Code-based TanStack Router tree (no file-based routes plugin — the
 * verifier is a single screen). The router's job here is URL hygiene:
 * `/` renders the app, anything else is a real 404 instead of the
 * default view silently rendered under a bogus URL.
 */
import { createRootRoute, createRoute, createRouter, Link, Outlet } from '@tanstack/react-router'
import { Compass } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { App } from './App'

function NotFound() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center bg-background text-foreground">
      <Compass className="w-10 h-10 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">This address doesn't exist on the verifier.</p>
      </div>
      <Button asChild variant="outline">
        <Link to="/">Go to the verifier</Link>
      </Button>
    </div>
  )
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: App,
})

const routeTree = rootRoute.addChildren([indexRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
