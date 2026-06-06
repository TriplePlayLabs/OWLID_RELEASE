import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { TooltipProvider } from '@owlid/ui/components/ui/tooltip'
import { ModalsPortal } from '@owlid/ui/modal'
import { Toaster } from 'sonner'
import { AppShell } from '~/components/AppShell'
import { HydrationGate } from '~/components/LoadingScreen'
import { devtoolsEnabled } from '~/lib/dev'

import appCss from '../styles.css?url'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      refetchOnWindowFocus: false,
    },
  },
})

// `window.__OWLID_CONFIG__` typing is supplied by `@owlid/config`'s global
// `declare global { interface Window { __OWLID_CONFIG__?: RuntimeConfig } }`.
// Redeclaring it here with stricter required fields collides with that
// module-augmented type. We just consume it.

function runtimeConfigScript() {
  const config =
    typeof window === 'undefined'
      ? {
          verificationUrl: process.env.OWLID_VERIFICATION_URL || '',
          issuerUrl: process.env.OWLID_ISSUER_URL || '',
          apiKey: process.env.OWLID_API_KEY || '',
          wsBaseUrl: process.env.OWLID_WS_BASE_URL || '',
          // Operator-suggested proof-server URL — the holder still has to
          // opt into proof-server mode from /settings; this is just the
          // default value the input is pre-populated with.
          proofServerUrl: process.env.OWLID_PROOF_SERVER_URL || '',
        }
      : window.__OWLID_CONFIG__ || {
          verificationUrl: '',
          issuerUrl: '',
          apiKey: '',
          wsBaseUrl: '',
          proofServerUrl: '',
        }

  return `window.__OWLID_CONFIG__ = ${JSON.stringify(config)};`
}

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-8">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="text-muted-foreground text-sm">
          {error instanceof Error ? error.message : 'An unexpected error occurred.'}
        </p>
        <div className="flex gap-2 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
          >
            Try Again
          </button>
          <button
            onClick={() => (window.location.href = '/')}
            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90"
          >
            Go Home
          </button>
        </div>
      </div>
    </div>
  )
}

export const Route = createRootRoute({
  errorComponent: RootErrorComponent,
  // Root-level layout: app chrome wraps every matched child route via
  // the AppShell's <Outlet />. Keeps the shared header out of every
  // page's body.
  component: AppShell,
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1.0, maximum-scale=1',
      },
      {
        title: 'Owl ID - Secure Identity',
      },
      {
        property: 'og:title',
        content: 'Owl ID - Secure Identity',
      },
      {
        property: 'og:description',
        content: 'Next-generation passwordless authentication prototype.',
      },
      {
        property: 'og:type',
        content: 'website',
      },
      {
        name: 'twitter:card',
        content: 'summary_large_image',
      },
      {
        name: 'twitter:title',
        content: 'Owl ID - Secure Identity',
      },
      {
        name: 'twitter:description',
        content: 'Next-generation passwordless authentication prototype.',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/favicon.svg',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.googleapis.com',
      },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300..700&family=JetBrains+Mono:wght@400;500&display=swap',
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: runtimeConfigScript() }} />
      </head>
      <body className="bg-background text-foreground antialiased">
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Toaster />
            <HydrationGate>{children}</HydrationGate>
            <ModalsPortal />
            {devtoolsEnabled() && (
              <>
                <ReactQueryDevtools initialIsOpen={false} />
                <TanStackDevtools
                  config={{
                    position: 'bottom-right',
                  }}
                  plugins={[
                    {
                      name: 'Tanstack Router',
                      render: <TanStackRouterDevtoolsPanel />,
                    },
                  ]}
                />
              </>
            )}
          </TooltipProvider>
          <Scripts />
        </QueryClientProvider>
      </body>
    </html>
  )
}
