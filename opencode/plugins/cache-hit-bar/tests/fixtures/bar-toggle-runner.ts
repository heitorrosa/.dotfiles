import { createComputed, createRoot, createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

/**
 * Click-toggle driver: renders a BarProbe with a recording fake dialog,
 * clicks the footer row twice via mockMouse, and prints dialog call counts.
 * Run as a subprocess (`bun --conditions=browser`).
 *
 * Usage: bun --conditions=browser tests/fixtures/bar-toggle-runner.ts <module path>
 */
const modulePath = process.argv[2]
if (!modulePath) throw new Error("usage: bar-toggle-runner.ts <module path>")

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

const mod = (await import(modulePath)) as {
  BarProbe: () => unknown
  dialogCalls: { show: number; clear: number }
}

const setup = await testRender(() => mod.BarProbe() as never, { width: 80, height: 3 })

// Let the 200ms child-sync debounce + history promise settle.
await new Promise((resolve) => setTimeout(resolve, 600))
await setup.renderOnce()
await setup.mockMouse.click(5, 0, 0)
await setup.flush()
await setup.renderOnce()
await setup.mockMouse.click(5, 0, 0)
await setup.flush()
await setup.renderOnce()
const frame = setup.captureCharFrame()

console.log(JSON.stringify({ module: modulePath, calls: mod.dialogCalls, frame }))
