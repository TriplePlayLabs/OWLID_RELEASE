import { useState, useRef, useEffect } from 'react'
import { ClipboardPaste, X, Send } from 'lucide-react'
import { Button } from '@owlid/ui/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@owlid/ui/components/ui/card'
import { Textarea } from '@owlid/ui/components/ui/textarea'

interface PasteInputProps {
  onSubmit: (token: string) => void
  onCancel: () => void
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

  const isValid = value.trim().startsWith('OID1:')
  const hasContent = value.trim().length > 0

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ClipboardPaste className="w-5 h-5 text-blue-400" />
          Paste Token
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
            placeholder="Paste compact token (OID1:...)"
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
          <p className="text-xs text-amber-400">Token should start with "OID1:" prefix</p>
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
