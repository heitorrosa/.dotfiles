export type SessionListEntry = { id: string; parentID?: string; created?: number }

export function parseSessionListResponse(all: unknown): SessionListEntry[] {
  const list = Array.isArray(all) ? all : ((all as { data?: unknown })?.data ?? [])
  if (!Array.isArray(list)) return []
  return list.map((raw) => {
    const s = raw as {
      id?: string
      parentID?: string
      time?: { created?: number }
      createdAt?: number
    }
    return {
      id: s.id ?? "",
      parentID: s.parentID,
      created: s.time?.created ?? s.createdAt,
    }
  }).filter((e) => e.id.length > 0)
}

export function childSessionIdsForParent(list: SessionListEntry[], parentId: string): string[] {
  return list.filter((s) => s.parentID === parentId).map((s) => s.id)
}

export function childSessionEntriesForParent(
  list: SessionListEntry[],
  parentId: string,
): SessionListEntry[] {
  return list.filter((s) => s.parentID === parentId)
}
