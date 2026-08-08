import { useState } from 'react'
import {
  IconArrowRight,
  IconBolt,
  IconCheck,
  IconFilter,
  IconLock,
  IconSearch,
  IconUser,
} from '../icons'
import { CHECKS, PRESETS, groupOrder, type CheckGroup, type PresetDef } from '../design-data'
import { ConsentPreview, Eyebrow, iconFor } from '../components/common'

interface HomeScreenProps {
  displayName: string
  setDisplayName: (v: string) => void
  selected: string[]
  toggleCheck: (id: string) => void
  setSelected: (ids: string[]) => void
  activePreset: string | null
  setActivePreset: (id: string | null) => void
  onContinue: () => void
}

export function HomeScreen({
  displayName,
  setDisplayName,
  selected,
  toggleCheck,
  setSelected,
  activePreset,
  setActivePreset,
  onContinue,
}: HomeScreenProps) {
  const [search, setSearch] = useState('')

  const applyPreset = (preset: PresetDef) => {
    setActivePreset(preset.id)
    setSelected(preset.checks)
  }

  const filtered = (group: CheckGroup) =>
    CHECKS.filter((c) => c.group === group).filter(
      (c) => !search || c.label.toLowerCase().includes(search.toLowerCase()),
    )

  return (
    <div className="split reveal">
      <div className="flex flex-col gap-5">
        <section className="card card-hero">
          <Eyebrow>Start session · Step 01 of 03</Eyebrow>
          <h1 className="heading-display mt-3.5 mb-3">What do you need to verify?</h1>
          <p className="lede max-w-[580px]">
            Pick a preset or compose your own. The holder will see exactly these checks on their
            consent screen — and nothing else leaves their device.
          </p>

          <div className="mt-7">
            <div className="field-label">
              <IconBolt /> Quick presets
            </div>
            <div className="preset-grid">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`preset ${activePreset === p.id ? 'active' : ''}`}
                  onClick={() => applyPreset(p)}
                >
                  <div className="preset-head">
                    <span className="preset-icon">{iconFor(p.icon)}</span>
                    <span className="preset-name">{p.name}</span>
                  </div>
                  <span className="preset-desc">{p.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-7">
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <div className="field-label m-0">
                <IconFilter /> Or pick individual checks
              </div>
              <div className="flex items-center gap-2 border border-[var(--line-2)] bg-[var(--bg-1)] px-3 py-1.5">
                <IconSearch size={14} className="text-[var(--text-3)]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className="w-[90px] border-0 bg-transparent text-[13px] text-[var(--text-1)] outline-none"
                />
              </div>
            </div>

            <div className="flex flex-col gap-[18px]">
              {groupOrder.map((group) => {
                const items = filtered(group)
                if (!items.length) return null
                return (
                  <div className="chip-group" key={group}>
                    <div className="chip-group-title">{group}</div>
                    <div className="chip-row">
                      {items.map((c) => (
                        <button
                          key={c.id}
                          className={`chip ${selected.includes(c.id) ? 'selected' : ''}`}
                          onClick={() => {
                            setActivePreset(null)
                            toggleCheck(c.id)
                          }}
                          aria-pressed={selected.includes(c.id)}
                        >
                          <span className="icon-wrap">
                            {selected.includes(c.id) ? <IconCheck /> : iconFor(c.icon)}
                          </span>
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="field-label">
            <IconUser /> Your display name
          </div>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. The Blue Owl Café"
          />
          <div className="field-hint">
            Shown on the holder's consent screen so they know who's asking.
          </div>
        </section>

        <div className="flex justify-between items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 text-[13px] text-[var(--text-3)]">
            <IconLock size={14} />
            End-to-end encrypted · zero-knowledge proofs
          </div>
          <button
            className="btn btn-primary btn-lg"
            disabled={selected.length === 0 || !displayName.trim()}
            onClick={onContinue}
          >
            Continue to scan
            <IconArrowRight />
          </button>
        </div>
      </div>

      <ConsentPreview displayName={displayName} selected={selected} />
    </div>
  )
}
