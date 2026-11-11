/**
 * config.ts — shared configuration constants (Phase 1a Deck port).
 *
 * The boss (you) comes from office.config.json at build time (Vite bundles it
 * through import.meta.glob below). The runtime GET /config read is removed:
 * the iframe has no network access, and the Deck owns the boss identity.
 */

// Shape of the optional office.config.json
type UserConfig = { boss?: { name?: string; sprite?: string; color?: string; emoji?: string } }

/** The boss fields. */
export interface BossConfig { name: string; sprite: string; color: string; emoji: string }

// Load user config (office.config.json) — bundled by Vite.
// import.meta.glob is resolved at build time and yields {} when the file is
// missing, so no top-level await is needed (the build target rejects it).
const userConfigModules = import.meta.glob<UserConfig>('../office.config.json', { eager: true, import: 'default' })
const userConfig: UserConfig = Object.values(userConfigModules)[0] ?? {}

const bossName   = userConfig.boss?.name   ?? 'Boss'
const bossSprite = userConfig.boss?.sprite ?? 'Me-1'
const bossColor  = userConfig.boss?.color  ?? '#ff4444'
const bossEmoji  = userConfig.boss?.emoji  ?? '👑'

// The boss — always in the office. `let`: applyBossConfig rebinds them.
export let BOSS_CHAR = bossSprite
export const BOSS_ROLE = 'boss'
export let BOSS_NAME = bossName
export let BOSS_COLOR = bossColor
export let BOSS_EMOJI = bossEmoji

/**
 * The boss's AGENT_CONFIGS entry, shared by reference with src/types.ts so
 * that a runtime update here is an update there.
 */
export const BOSS_CONFIG: { color: string; emoji: string; title: string } = { color: bossColor, emoji: bossEmoji, title: bossName }

/** The values the bundle was built with. */
export const BUILD_TIME_BOSS: Readonly<BossConfig> = Object.freeze({ name: bossName, sprite: bossSprite, color: bossColor, emoji: bossEmoji })

// Map agent roles to character sprite base names (in sprites/characters/)
export const ROLE_TO_CHAR: Record<string, string> = {
  'boss':                  bossSprite,
  'assistant':             'Claude-1',
  'debugger':              'dev-1',
  'code-reviewer':         'employee-1',
  'frontend-developer':    'Frontend-dev-1',
  'fullstack-developer':   'dev-2',
  'test-engineer':         'employee-2',
  'security-auditor':      'security-audit-1',
  'devops-engineer':       'employee-3',
  'architect-reviewer':    'employee-1',
  'performance-engineer':  'employee-2',
  'database-architect':    'employee-3',
  'typescript-pro':        'employee-1',
  'ai-engineer':           'dev-2',
  'prompt-engineer':       'dev-2',
  'general-purpose':       'employee-3',
  'Explore':               'explore-1',
  // MCPs
  'github':                'employee-3',
  'supabase':              'Frontend-dev-1',
  'playwright':            'employee-2',
  'chrome':                'employee-1',
  'memory':                'dev-2',
  'seo':                   'Frontend-dev-1',
  'gmail':                 'dev-1',
  'ios-simulator':         'security-audit-1',
}

/**
 * Make `boss` the boss: rebind the exports and update the shared records in
 * place. Missing or non-string fields keep their current value.
 */
export function applyBossConfig(boss: Partial<BossConfig> | null | undefined): BossConfig {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  if (boss && typeof boss === 'object') {
    BOSS_NAME  = text(boss.name)   ?? BOSS_NAME
    BOSS_CHAR  = text(boss.sprite) ?? BOSS_CHAR
    BOSS_COLOR = text(boss.color)  ?? BOSS_COLOR
    BOSS_EMOJI = text(boss.emoji)  ?? BOSS_EMOJI
  }
  BOSS_CONFIG.title = BOSS_NAME
  BOSS_CONFIG.color = BOSS_COLOR
  BOSS_CONFIG.emoji = BOSS_EMOJI
  ROLE_TO_CHAR[BOSS_ROLE] = BOSS_CHAR
  return { name: BOSS_NAME, sprite: BOSS_CHAR, color: BOSS_COLOR, emoji: BOSS_EMOJI }
}
