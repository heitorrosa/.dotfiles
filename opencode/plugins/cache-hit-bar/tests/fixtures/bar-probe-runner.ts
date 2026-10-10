import { createComputed, createRoot, createSignal } from "solid-js"
import { testRender } from "@opentui/solid"

/**
 * Drives tests/fixtures/bar-probe.tsx in a real opentui test renderer and
 * prints the captured char frame as JSON. Run as a subprocess
 * (`bun --conditions=browser`) so the probe resolves the reactive Solid
 * runtime, mirroring the upstream fold-probe-runner pattern.
 *
 * Usage: bun --conditions=browser tests/fixtures/bar-probe-runner.ts <module path>
 */
const modulePath = process.argv[2]
if (!modulePath) throw new Error("usage: bar-probe-runner.ts <module path>")

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

const height = Number(process.argv[3] ?? 3)
const setup = (await testRender(() => mod.BarProbe() as never, { width: 80, height })) as unknown as {
  renderOnce: () => Promise<unknown>
  captureCharFrame: () => string
}

// Let the 200ms child-sync debounce + history promise settle.
await new Promise((resolve) => setTimeout(resolve, 600))
await setup.renderOnce()
const frame = setup.captureCharFrame()

console.log(JSON.stringify({ module: modulePath, frame }))
