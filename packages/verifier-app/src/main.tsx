import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import { Toaster } from 'sonner'
import { ModalsPortal } from '@owlid/ui/modal'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Toaster
      position="top-center"
      // Explicit duration + close button so a toast can never linger
      // indefinitely (sonner pauses its auto-dismiss timer while the
      // window is unfocused or hovered).
      closeButton
      toastOptions={{
        duration: 6000,
        style: { background: '#18181b', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' },
      }}
    />
    <ModalsPortal />
  </StrictMode>,
)
