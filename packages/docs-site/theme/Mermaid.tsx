import { useEffect, useId, useState } from 'react'
import mermaid from 'mermaid'

interface Props {
  code: string
}

// One palette per scheme. Keep these in lockstep with the project's
// design tokens so diagrams blend with the rest of the docs theme.
const LIGHT = {
  primaryColor: '#fef3c7',
  primaryTextColor: '#1f2937',
  primaryBorderColor: '#d97706',
  secondaryColor: '#dbeafe',
  secondaryTextColor: '#1e3a8a',
  secondaryBorderColor: '#2563eb',
  tertiaryColor: '#ede9fe',
  tertiaryTextColor: '#4c1d95',
  tertiaryBorderColor: '#7c3aed',
  lineColor: '#475569',
  background: 'transparent',
  mainBkg: '#fef3c7',
  clusterBkg: '#f8fafc',
  clusterBorder: '#cbd5e1',
  edgeLabelBackground: '#fefce8',
  textColor: '#1f2937',
  titleColor: '#1f2937',
  // sequenceDiagram
  actorBkg: '#fef3c7',
  actorBorder: '#d97706',
  actorTextColor: '#1f2937',
  actorLineColor: '#475569',
  signalColor: '#475569',
  signalTextColor: '#1f2937',
  labelBoxBkgColor: '#dbeafe',
  labelBoxBorderColor: '#2563eb',
  labelTextColor: '#1e3a8a',
  loopTextColor: '#1f2937',
  noteBkgColor: '#fef9c3',
  noteTextColor: '#713f12',
  noteBorderColor: '#ca8a04',
  activationBkgColor: '#dbeafe',
  activationBorderColor: '#2563eb',
  sequenceNumberColor: '#fef3c7',
}

const DARK = {
  primaryColor: '#78350f',
  primaryTextColor: '#fef3c7',
  primaryBorderColor: '#fbbf24',
  secondaryColor: '#1e3a8a',
  secondaryTextColor: '#dbeafe',
  secondaryBorderColor: '#60a5fa',
  tertiaryColor: '#4c1d95',
  tertiaryTextColor: '#ede9fe',
  tertiaryBorderColor: '#a78bfa',
  lineColor: '#cbd5e1',
  background: 'transparent',
  mainBkg: '#78350f',
  clusterBkg: '#1e293b',
  clusterBorder: '#64748b',
  edgeLabelBackground: '#1e293b',
  textColor: '#f8fafc',
  titleColor: '#f8fafc',
  // sequenceDiagram
  actorBkg: '#78350f',
  actorBorder: '#fbbf24',
  actorTextColor: '#fef3c7',
  actorLineColor: '#cbd5e1',
  signalColor: '#cbd5e1',
  signalTextColor: '#f1f5f9',
  labelBoxBkgColor: '#1e3a8a',
  labelBoxBorderColor: '#60a5fa',
  labelTextColor: '#dbeafe',
  loopTextColor: '#f1f5f9',
  noteBkgColor: '#365314',
  noteTextColor: '#ecfccb',
  noteBorderColor: '#84cc16',
  activationBkgColor: '#1e3a8a',
  activationBorderColor: '#60a5fa',
  sequenceNumberColor: '#fef3c7',
}

export function Mermaid({ code }: Props) {
  const id = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      try {
        const isDark = document.documentElement.classList.contains('dark')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: 'base',
          themeVariables: isDark ? DARK : LIGHT,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        })
        const out = await mermaid.render(`mmd-${id}`, code)
        if (!cancelled) {
          setSvg(out.svg)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    render()
    const observer = new MutationObserver(() => render())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [code, id])

  if (error) {
    return (
      <pre style={{ background: '#fee2e2', padding: '1rem', borderRadius: 4, overflow: 'auto' }}>
        <code>
          Mermaid render error: {error}
          {'\n\n'}
          {code}
        </code>
      </pre>
    )
  }

  return <div className="owlid-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}

export default Mermaid
