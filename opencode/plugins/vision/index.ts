// vision — materialize user-message images to temp files so text-only
// models can delegate them; keeps media part and appends `[vision: <path>]`.
import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"

const dir = path.join(tmpdir(), "vision")
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif" }
const ext = (m: string) => EXT[m] ?? m.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "png"

async function markerFor(s: any): Promise<string | null> {
  try {
    if (!s) return null
    let buf: Buffer | null = null
    let mime = "image/png"
    if (s.type === "base64" && typeof s.data === "string") { buf = Buffer.from(s.data, "base64"); mime = s.mediaType || mime }
    else if (s.type === "bytes" && s.data instanceof Uint8Array) { buf = Buffer.from(s.data); mime = s.mediaType || mime }
    else if (s.type === "url" && typeof s.url === "string" && s.url) return s.url.startsWith("file://") ? decodeURIComponent(s.url.slice(7)) : s.url
    else return null
    if (!buf?.length) return null
    const file = path.join(dir, `img-${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext(mime)}`)
    await mkdir(dir, { recursive: true })
    await writeFile(file, buf)
    return file
  } catch { return null }
}

export default Plugin.define({
  id: "vision",
  async setup(ctx) {
    await ctx.session.hook("context", async (e: any) => {
      for (const m of e.messages as any[]) {
        if (m.role !== "user" || !Array.isArray(m.content)) continue
        const next: any[] = []
        let changed = false
        for (const p of m.content) {
          next.push(p)
          if (p?.type !== "media") continue
          const f = await markerFor(p.media?.source)
          if (f) { next.push({ type: "text", text: `[vision: ${f}]` }); changed = true }
        }
        if (changed) m.content = next
      }
    })
  },
})
