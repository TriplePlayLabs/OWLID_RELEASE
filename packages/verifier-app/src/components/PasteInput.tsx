import { useState, useRef, useEffect } from 'react'
import { ClipboardPaste, X, Send } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'
import { Textarea } from '@owlid/ui/components/ui/textarea'

interface PasteInputProps {
  onSubmit: (presentation: string) => void
  onCancel: () => void
}

// SD-JWT VC presentation shape: `<jwt>~<disclosure>~...~<kb-jwt>`.
// Three base64url segments separated by `~`, ending in a KB-JWT.
function isSdJwtVcPresentation(value: string): boolean {
  const segments = value.split('~')
  if (segments.length < 2) return false
  return segments.every((s) =>
    /^[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|^[A-Za-z0-9_-]+$/.test(s),
  )
}

export function PasteInput({ onSubmit, onCancel }: PasteInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
  }

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setValue(text.trim())
    } catch {
      /* noop — clipboard API unavailable, user pastes manually */
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
  }

  const isValid = isSdJwtVcPresentation(value.trim())
  const hasContent = value.trim().length > 0

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ClipboardPaste className="w-5 h-5 text-muted-foreground" />
          Paste presentation
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Cancel">
          <X className="w-4 h-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Paste SD-JWT VC presentation (<jwt>~<disclosure>~...~<kb-jwt>)"
            rows={5}
            className="font-mono"
          />
          {!hasContent && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handlePasteFromClipboard}
              className="absolute top-2 right-2"
            >
              Paste
            </Button>
          )}
        </div>
        {hasContent && !isValid && (
          <p className="text-xs text-amber-400">
            Expected SD-JWT VC presentation: dot-separated JWT segments joined by <code>~</code>.
          </p>
        )}
        <p className="text-xs text-muted-foreground">Press Cmd+Enter to verify</p>
      </CardContent>
      <CardFooter className="gap-3">
        <Button variant="outline" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="flex-1" onClick={handleSubmit} disabled={!hasContent}>
          <Send className="w-4 h-4" />
          Verify
        </Button>
      </CardFooter>
    </Card>
  )
}
