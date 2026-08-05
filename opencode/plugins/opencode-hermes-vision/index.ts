// hermes-vision — materialize pasted/dropped images to temp files so text-only
// models (hermes + deepseek-v4-flash) can delegate them to the vision subagent.
// A user message image arrives as a FilePart with mime image/*; opencode strips
// it to "ERROR: Cannot read image" for text-only models. This hook writes the
// bytes to a temp file and replaces the part with a path marker:
//   [hermes-vision: <path>]
// NOTE: built for a text-only harness. If you run a vision-capable primary,
// remove this plugin — it replaces image parts with path markers.
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin, Part } from "@opencode-ai/plugin"

const dir = path.join(tmpdir(), "hermes-vision")
let seq = 0

// base64 data URL -> {mime, data}; null if not a base64 image data URL
function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/s)
  if (!m) return null
  const data = Buffer.from(m[2], "base64")
  if (!data.length) return null
  return { mime: m[1], data }
}

// real filesystem path from a part url (data: URLs return null)
function realPath(url: string): string | null {
  if (url.startsWith("data:")) return null
  const p = url.replace(/^file:\/\//, "")
  return p ? decodeURIComponent(p) : null
}

export default (async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const msg of output.messages) {
        if (msg.info.role !== "user") continue
        const next: Part[] = []
        for (const part of msg.parts) {
          if (part.type !== "file" || !part.mime?.startsWith("image/")) {
            next.push(part)
            continue
          }
          const url = part.url
          const dl = typeof url === "string" ? decodeDataUrl(url) : null
          if (dl) {
            await mkdir(dir, { recursive: true })
            const file = path.join(dir, `img-${Date.now()}-${seq++}.png`)
            await writeFile(file, dl.data)
            next.push({ type: "text", text: `[hermes-vision: ${file}]` })
          } else {
            const p = typeof url === "string" ? realPath(url) : null
            if (p) next.push({ type: "text", text: `[hermes-vision: ${p}]` })
            else next.push(part) // not an image or no path available — leave it
          }
        }
        msg.parts = next
      }
    },
  }
}) satisfies Plugin
