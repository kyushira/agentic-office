/**
 * season.ts — Phase 1a stub. The seasonal (Christmas) art is stripped from the
 * Deck port, so every season query answers "no season" and every URL is the
 * normal art. The API stays so call sites compile unchanged.
 */

export type Season = 'christmas'

export const SEASON_SUFFIX: Record<Season, string> = { christmas: '-xmas' }

export function seasonFor(_now: Date, _search: string, _stored?: string): Season | null {
  return null
}

/** Always null: the port ships non-seasonal art only. */
export function currentSeason(): Season | null {
  return null
}

/** Identity: no festive copies exist in this build. */
export function seasonalVariant(url: string, _s: Season): string {
  return url
}

/** Identity: normal art only. */
export function seasonalUrl(url: string, _s: Season | null = null): string {
  return url
}

/** Never changes: nothing to re-render for. */
export function useSeasonArt(): number {
  return 0
}
