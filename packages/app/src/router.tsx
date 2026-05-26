import { createRouter } from '@tanstack/react-router'

import { LoadingScreen } from '~/components/LoadingScreen'
// Import the generated route tree
import { routeTree } from './routeTree.gen'

// Create a new router instance
export const getRouter = () => {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Brand the route-load wait — replaces the tiny generic ring that
    // TanStack Router shows by default.
    defaultPendingComponent: () => <LoadingScreen />,
    // Show the branded screen the moment a route starts loading and
    // hold it long enough that the transition doesn't flicker.
    defaultPendingMs: 0,
    defaultPendingMinMs: 400,
    defaultNotFoundComponent: () => <LoadingScreen caption="Route not found" />,
  })

  return router
}
