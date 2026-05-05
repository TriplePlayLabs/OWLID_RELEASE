import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Toaster } from '@owlid/ui/components/ui/sonner'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@owlid/ui/components/ui/sidebar'
import { Separator } from '@owlid/ui/components/ui/separator'
import { ModalsPortal } from '@owlid/ui/modal'
import { AppSidebar } from '~/components/AppSidebar'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@owlid/ui/components/ui/breadcrumb'
import { useAuth } from '~/hooks/use-auth'
import { LoginPage } from '~/components/LoginPage'
import { ChangePasswordScreen } from '~/components/ChangePasswordScreen'
import { Button } from '@owlid/ui/components/ui/button'
import { AlertTriangle, RefreshCw } from 'lucide-react'

import appCss from '../styles.css?url'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
    },
  },
})

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'OwlID Admin' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
    scripts: [
      // Runtime config — see docker/runtime-config.sh.
      { src: '/config.js' },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={queryClient}>
          <AuthGate>{children}</AuthGate>
          <ModalsPortal />
          <Toaster />
          <ReactQueryDevtools initialIsOpen={false} />
          <Scripts />
        </QueryClientProvider>
      </body>
    </html>
  )
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const {
    isAuthenticated,
    isBootstrapping,
    isBootstrapError,
    bootstrapError,
    refetchMe,
    mustChangeDefaultPassword,
  } = useAuth()

  if (isBootstrapping) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-6 w-6 rounded-full border-2 border-muted border-t-primary animate-spin" />
      </div>
    )
  }

  if (isBootstrapError) {
    // Verification service unreachable after the cap of bootstrap retries.
    // Don't fall through to the login form — there's no service to log in
    // to. Tell the user explicitly and give them a Retry button.
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-red-400" />
          </div>
          <h2 className="text-lg font-semibold">Cannot reach verification service</h2>
          <p className="text-sm text-muted-foreground">
            {bootstrapError instanceof Error && bootstrapError.message
              ? bootstrapError.message
              : 'The verification service did not respond after several attempts.'}
          </p>
          <Button onClick={() => refetchMe()}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginPage />
  }

  // Force the password-rotation interstitial when the operator just
  // signed in with the built-in default credentials. This sits between
  // the login redirect and the rest of the dashboard so no admin route
  // can be reached until rotation completes.
  if (mustChangeDefaultPassword) {
    return <ChangePasswordScreen />
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Admin</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex-1 overflow-auto p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
