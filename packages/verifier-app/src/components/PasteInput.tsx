import { useState, useRef, useEffect } from 'react'
import { ClipboardPaste, X, Send } from 'lucide-react'

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
    if (trimmed) {
      onSubmit(trimmed)
    }
  }

  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setValue(text.trim())
      }
    } catch {
      // Clipboard API not available, user can paste manually
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit()
    }
  }

  const isValid = value.trim().startsWith('OID1:')
  const hasContent = value.trim().length > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2">
          <ClipboardPaste className="w-5 h-5 text-blue-400" />
          Paste Token
        </h3>
        <button
          onClick={onCancel}
          className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
          aria-label="Cancel"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Paste compact token (OID1:...)"
          rows={5}
          className="w-full px-4 py-3 rounded-xl border border-white/10 bg-zinc-900 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 placeholder:text-zinc-600"
        />
        {!hasContent && (
          <button
            onClick={handlePasteFromClipboard}
            className="absolute top-3 right-3 px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 transition-colors"
          >
            Paste
          </button>
        )}
      </div>

      {hasContent && !isValid && (
        <p className="text-xs text-amber-400">Token should start with "OID1:" prefix</p>
      )}

      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-sm hover:bg-zinc-800 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!hasContent}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
          Verify
        </button>
      </div>

      <p className="text-xs text-center text-zinc-500">Press Cmd+Enter to verify</p>
    </div>
  )
}
