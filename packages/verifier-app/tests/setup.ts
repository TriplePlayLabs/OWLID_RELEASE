/**
 * Test bootstrap: install a jsdom window + the React-Testing-Library
 * `act` flag so component renders work under bun:test. Mirrors the
 * holder app's tests/setup.ts so both suites share the same DOM globals.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })

const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.navigator = dom.window.navigator
g.localStorage = dom.window.localStorage
g.sessionStorage = dom.window.sessionStorage
g.HTMLElement = dom.window.HTMLElement
g.HTMLDivElement = dom.window.HTMLDivElement
g.HTMLInputElement = dom.window.HTMLInputElement
g.Element = dom.window.Element
g.Node = dom.window.Node
g.Event = dom.window.Event
g.CustomEvent = dom.window.CustomEvent
g.MouseEvent = dom.window.MouseEvent
g.KeyboardEvent = dom.window.KeyboardEvent
g.getComputedStyle = dom.window.getComputedStyle
// React 19 act() requires this — without it RTL's render throws.
g.IS_REACT_ACT_ENVIRONMENT = true
