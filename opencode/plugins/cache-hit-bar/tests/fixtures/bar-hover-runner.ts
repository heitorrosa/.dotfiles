import { createComputed, createRoot, createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

/**
 * Hover-fg driver: renders the two-row hover probe (rest + hovered side by
 * side) and prints span frames with fg values. Run as a subprocess
 * (`bun --conditions=browser`).
 *
 * Usage: bun --conditions=browser tests/fixtures/bar-hover-runner.ts <module path>
 */
const modulePath = process.argv[2]
if (!modulePath) throw new Error("usage: bar-hover-runner.ts <module path>")

const reactive = createRoot(() => {
  const [value, setValue] = createSignal(0)
  let runs = 0
  createComputed(() => {
    value()
    runs++
  })
  setValue(1)
  return runs > 1
})
if (!reactive) {
  throw new Error("no reactive Solid runtime in this process: run with --conditions=browser")
}

const mod = (await import(modulePath)) as { BarProbe: () => unknown }

const setup = await testRender(() => mod.BarProbe() as never, { width: 80, height: 3 })

// Let the 200ms child-sync debounce + history promise settle.
await new Promise((resolve) => setTimeout(resolve, 600))
await setup.renderOnce()

const slim = (frame: { lines: { spans: { text: string; fg: { r: number; g: number; b: number; a: number } }[] }[] }) =>
  frame.lines.map((l) => l.spans.map((s) => ({ text: s.text, fg: [s.fg.r, s.fg.g, s.fg.b, s.fg.a] })))

console.log(JSON.stringify({ module: modulePath, spans: slim(setup.captureSpans()) }))
