/**
 * Test bootstrap: install a jsdom window + the React-Testing-Library
 * `act` flag so renderHook works under bun:test, then expose a mock
 * WebSocket the suite drives by hand. Kept in one file so every test
 * runs against the same DOM globals.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })

// Mirror what jsdom exposes onto Node globals so React-DOM, RTL,
// Radix, and React's scheduler all find their host.
const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.navigator = dom.window.navigator
g.HTMLElement = dom.window.HTMLElement
g.HTMLDivElement = dom.window.HTMLDivElement
g.Element = dom.window.Element
g.Node = dom.window.Node
g.Event = dom.window.Event
g.CustomEvent = dom.window.CustomEvent
g.MouseEvent = dom.window.MouseEvent
g.KeyboardEvent = dom.window.KeyboardEvent
g.getComputedStyle = dom.window.getComputedStyle
// React 19 act() requires this — without it RTL's renderHook throws.
g.IS_REACT_ACT_ENVIRONMENT = true

// crypto.subtle / TextEncoder are already on the bun runtime; jsdom
// only fills in DOM types.
