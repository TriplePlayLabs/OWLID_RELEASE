import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Toaster } from 'sonner'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Toaster
      position="top-center"
      toastOptions={{
        style: { background: '#18181b', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' },
      }}
    />
  </StrictMode>,
)
