/**
 * theme.ts — the default theme only (Phase 1a Deck port).
 *
 * The upstream alternate theme (cast, cats, rooms, chatter, props) is
 * excluded from this build. Every query answers with the default art and
 * default copy, and setTheme is a no-op, so no call site needs to know.
 */
import { useSyncExternalStore } from 'react'
import { getVariant, pickIncidentLine, type IncidentLineKind } from './incident'
import { ASSET_BASE } from './assetBase'

export type ThemeName = 'default'

const noop = () => {}
const subscribeNone = (_fn: () => void) => noop

export function getTheme(): ThemeName { return 'default' }
export function setTheme(_name: ThemeName) { /* only the default theme exists */ }
export function toggleTheme() { /* only the default theme exists */ }
export function subscribeTheme(_fn: () => void): () => void { return noop }
export function useTheme(): ThemeName {
  return useSyncExternalStore(subscribeNone, () => 'default' as const, () => 'default' as const)
}

/** The default cast: the role's own character base. */
export function getCharacterBaseForRole(_role: string, defaultBase: string): string {
  return defaultBase
}

export function getSpriteDir(): string {
  return `${ASSET_BASE}sprites/characters`
}

/** Kept signature-compatible for existing callers — agentId ignored; role is the key. */
export function getSpritePath(_agentId: string, role: string, defaultBase: string, direction: string): string {
  void role
  return `${getSpriteDir()}/${defaultBase}-${direction}.webp`
}

export function getRoomImage(phase: 'day' | 'night'): string {
  return `${ASSET_BASE}rooms/office-${phase === 'night' ? 'night' : 'day'}.webp`
}

/** No second cast member in the default theme. */
export function getAngelaCat(): { role: string; catSprite: string } | null {
  return null
}

/** The default theme keeps the agent's own display name. */
export function themedDisplayName(_role: string, fallback: string): string {
  return fallback
}

const DEFAULT_SPAWN = [
  'reporting for duty!', 'clocked in', 'ready to ship',
  'coffee first, then code', "let's do this", 'opening vim...', 'pulling latest main',
]
const DEFAULT_WORK = [
  'on it', 'typing furiously', 'in the zone', 'making progress',
  'checking the docs', 'git blame time', 'stack overflow to the rescue',
]
const DEFAULT_DONE = [
  'task complete!', 'shipped it', 'PR opened', 'done and dusted',
  'LGTM', 'merged to main', 'deployed',
]
const DEFAULT_COFFEE = ['brb, coffee', 'need caffeine', 'grabbing a cup', 'coffee run']
const DEFAULT_WATER = [
  'stay hydrated', 'h2o break', 'water run', 'refilling bottle',
  'hydration check', 'quick water break',
]

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

// Pool order: incident variant (while active) → default.
function variantLine(kind: IncidentLineKind): string | null {
  if (getVariant() !== 'incident') return null
  return pickIncidentLine(kind)
}

export function themedSpawn(): string  { return variantLine('spawn')  ?? pick(DEFAULT_SPAWN) }
export function themedWork(): string   { return variantLine('work')   ?? pick(DEFAULT_WORK) }
export function themedDone(): string   { return variantLine('done')   ?? pick(DEFAULT_DONE) }
export function themedCoffee(): string { return variantLine('coffee') ?? pick(DEFAULT_COFFEE) }
export function themedWater(): string  { return variantLine('water')  ?? pick(DEFAULT_WATER) }

/** No prop override in the default theme: the caller falls back to its own sprite. */
export function getOfficePropForRole(_role: string): string | null {
  return null
}
