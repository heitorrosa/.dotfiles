/** @jsxImportSource @opentui/solid */
import { CacheHitBarHost } from "./bar.tsx"
import { createV2Api } from "./v2/adapter.ts"
import { toThemeRecord } from "./v2/map.ts"
import type { OpenCodeTuiApi, V1TuiApi } from "./types.ts"
import type { V2Context, V2Dialog } from "./v2/types.ts"

export const PLUGIN_ID = "cache-hit-bar"

/** Native muted-gray for footer text: V2 ResolvedTheme `theme.text.muted` (RGBA object, passed straight to `fg` like the built-in `prompt.footer.location/file` rows). Accepts string hex too; undefined = host default (NOT gray). */
export function resolveMutedFg(theme: unknown): unknown {
  const v = toThemeRecord(theme).textMuted as unknown
  if (typeof v === "string") return v.length > 0 ? v : undefined
  if (v !== null && typeof v === "object") return v
  return undefined
}

/** Base/white token from the SAME theme record as the muted gray (V2 `theme.text.base`); the hovered row fg. V1 themes carry no base token → undefined (callers fall back to muted). */
export function resolveBaseFg(theme: unknown): unknown {
  const v = toThemeRecord(theme).text as unknown
  if (typeof v === "string") return v.length > 0 ? v : undefined
  if (v !== null && typeof v === "object") return v
  return undefined
}

type HoverInput = { hovered?: () => boolean; onMouseOver?: (ev?: unknown) => void; onMouseOut?: (ev?: unknown) => void }

function bar(api: OpenCodeTuiApi, sessionId: string, muted?: unknown, dialog?: V2Dialog, base?: unknown, hover?: HoverInput) {
  return <CacheHitBarHost sessionId={sessionId} api={api} muted={muted} dialog={dialog} base={base} hovered={hover?.hovered} onMouseOver={hover?.onMouseOver} onMouseOut={hover?.onMouseOut} />
}

type RegisterArg = Parameters<V1TuiApi["slots"]["register"]>[0]

/**
 * V1 surface: app_bottom is a first-class host slot there. It carries no
 * session props, so track the latest active session from message events.
 * (Kept for V1 runtimes; the live 2.0.22 runtime only calls setup().)
 */
export const tui = async (api: V1TuiApi) => {
  let currentSessionId = ""
  api.event.on("message.updated", (event) => {
    const sid = (event.properties?.info as { sessionID?: string } | undefined)?.sessionID
    if (sid) currentSessionId = sid
  })
  api.slots.register({
    order: 57,
    slots: {
      app_bottom() {
        return bar(api, currentSessionId)
      },
    },
  } as unknown as RegisterArg)
}

/**
 * V2 surface. Mount the LEFT cell of the composer downbar
 * (`prompt.footer.status`, flex-start row — same slot the built-in `/btw`
 * badge uses) so the bar hugs the left edge, away from the right-side
 * `104.0K (10%) · $1.63` usage segment. Text uses the native
 * `theme.text.muted` gray — no custom colors. (V1 `app_bottom` below untouched.)
 */
export const setup = (ctx: V2Context) => {
  const api = createV2Api(ctx)
  const muted = resolveMutedFg(ctx.theme)
  const base = resolveBaseFg(ctx.theme)
  const dialog = ctx.ui.dialog
  const unregister = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => bar(api, input.sessionID ?? "", muted, dialog, base, input),
  })
  return () => {
    unregister?.()
    api.dispose()
  }
}

const plugin = { id: PLUGIN_ID, tui, setup }
export default plugin
