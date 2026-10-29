/**
 * The ids a usage document reports as first seen by THIS machine, normalised.
 *
 * One filter, two surfaces. Both the composer pill's "· N 新模型" segment and the
 * host model picker's per-row marker have to agree about which models are new,
 * so they must not each invent their own reading of the list — a difference
 * between the two would show a pill that counts two and a picker that marks
 * three. They therefore share this single normaliser, and both read the SAME
 * usage document the Host already serves.
 *
 * Three filters, none of them optional:
 * 1. Not an array answers `[]` rather than throwing. The Host's answer is the
 *    source of truth, so a missing field is "nothing to show", never an error.
 * 2. A non-string, or an id that is only whitespace, is dropped.
 * 3. Duplicates are dropped. The Host already dedupes, but the client must not
 *    trust a peer: a duplicated id would turn "2 新模型" into two rows naming
 *    the same model and stop the count meaning anything.
 *
 * @param raw - The `newModelIds` field of a usage document.
 * @returns The ids, in the order the Host sent them.
 */
export function normalizeNewModelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}