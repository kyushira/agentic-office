import { ASSET_BASE } from './assetBase'
// ===== ASSET MANIFEST =====
// Maps logical asset names to actual file paths
// Sizes are display sizes (px) at 800x600 room resolution
// Source images are ~6x larger (4800x3584 room)

export interface SpriteAsset {
  path: string
  width: number     // display width in px
  height: number    // display height in px
  category: 'character' | 'furniture' | 'appliance' | 'decoration' | 'effect' | 'culture' | 'room'
}

// All available sprite assets — sizes derived from actual image dimensions / scale
export const ASSETS: Record<string, SpriteAsset> = {
  // === CHARACTERS (307x862 source → ~51x144 display... too tall, scale to fit ~65px height) ===
  'char-debugger':       { path: ASSET_BASE + 'sprites/debugger.webp', width: 24, height: 65, category: 'character' },
  'char-reviewer':       { path: ASSET_BASE + 'sprites/reviewer.webp', width: 24, height: 65, category: 'character' },
  'char-frontend':       { path: ASSET_BASE + 'sprites/frontend.webp', width: 24, height: 65, category: 'character' },
  'char-fullstack':      { path: ASSET_BASE + 'sprites/fullstack.webp', width: 24, height: 65, category: 'character' },
  'char-tester':         { path: ASSET_BASE + 'sprites/tester.webp', width: 24, height: 65, category: 'character' },
  'char-security':       { path: ASSET_BASE + 'sprites/security.webp', width: 24, height: 65, category: 'character' },
  'char-devops':         { path: ASSET_BASE + 'sprites/devops.webp', width: 24, height: 65, category: 'character' },
  'char-manager':        { path: ASSET_BASE + 'sprites/manager.webp', width: 24, height: 65, category: 'character' },

  // === FURNITURE ===
  // Standing desks: ~580x720 source → ~97x120 at 6x... scale to ~70px wide
  'desk-standing-left-front':  { path: ASSET_BASE + 'sprites/furniture/standing-desk-left-front.webp', width: 84, height: 106, category: 'furniture' },
  'desk-standing-left-rear':   { path: ASSET_BASE + 'sprites/furniture/standing-desk-left-rear.webp', width: 84, height: 102, category: 'furniture' },
  'desk-standing-right-front': { path: ASSET_BASE + 'sprites/furniture/standing-desk-right-front.webp', width: 84, height: 106, category: 'furniture' },
  'desk-standing-right-rear':  { path: ASSET_BASE + 'sprites/furniture/standing-desk-right-rear.webp', width: 84, height: 102, category: 'furniture' },
  // Filing cabinet: 312x422 → ~52x70, scaled 1.2x
  'filing-closed':             { path: ASSET_BASE + 'sprites/furniture/filling-closed.webp', width: 42, height: 56, category: 'furniture' },
  'filing-open':               { path: ASSET_BASE + 'sprites/furniture/filling-open.webp', width: 46, height: 60, category: 'furniture' },

  // === APPLIANCES ===
  // Coffee machine: 296x378 → ~49x63
  'coffee-off':    { path: ASSET_BASE + 'sprites/appliances/coffee-off.webp', width: 40, height: 51, category: 'appliance' },
  'coffee-on':     { path: ASSET_BASE + 'sprites/appliances/coffee-on.webp', width: 40, height: 51, category: 'appliance' },

  // === DECORATION ===
  // Monstera: 394x563 → ~66x94
  'plant-monstera':  { path: ASSET_BASE + 'sprites/decoration/monstera-plant.webp', width: 50, height: 71, category: 'decoration' },
  // Snake plant: 347x543 → ~58x91
  'plant-snake':     { path: ASSET_BASE + 'sprites/decoration/snake-plant.webp', width: 40, height: 63, category: 'decoration' },
  // Money tree: 351x531 → ~59x89
  'plant-money':     { path: ASSET_BASE + 'sprites/decoration/money-tree.webp', width: 42, height: 63, category: 'decoration' },
  // Whiteboard: 750x996 → ~125x166
  'whiteboard':      { path: ASSET_BASE + 'sprites/decoration/white-board.webp', width: 65, height: 86, category: 'decoration' },
  // AC unit: 492x380 → ~82x63
  'ac-unit':         { path: ASSET_BASE + 'sprites/decoration/ac-wall-unit.webp', width: 50, height: 39, category: 'decoration' },
  // Printer: 450x563 → ~75x94
  'printer':         { path: ASSET_BASE + 'sprites/decoration/printer.webp', width: 55, height: 69, category: 'decoration' },
  'printer-working': { path: ASSET_BASE + 'sprites/decoration/printer-working.webp', width: 55, height: 69, category: 'decoration' },
  'printer-broken':  { path: ASSET_BASE + 'sprites/decoration/printer-broken.webp', width: 55, height: 69, category: 'decoration' },

  // === CULTURE ===
  // Bell: 167x331 → ~28x55
  'bell':              { path: ASSET_BASE + 'sprites/culture/bell.webp', width: 18, height: 36, category: 'culture' },
  // Days last incident: 1241x1024 → ~207x171
  'days-last-incident': { path: ASSET_BASE + 'sprites/culture/days-last-incident.webp', width: 80, height: 66, category: 'culture' },
  // Deploying screen: 852x991 → ~142x165
  'deploying-screen':  { path: ASSET_BASE + 'sprites/culture/deploying-screen.webp', width: 60, height: 70, category: 'culture' },
  // Todo board: 606x686 → ~101x114
  'todo-board':        { path: ASSET_BASE + 'sprites/culture/todo-board.webp', width: 55, height: 62, category: 'culture' },

  // === EFFECTS (small overlays — keep compact) ===
  'fx-build-failed':   { path: ASSET_BASE + 'sprites/effects/build-failed.webp', width: 24, height: 24, category: 'effect' },
  'fx-fire':           { path: ASSET_BASE + 'sprites/effects/fire.webp', width: 24, height: 24, category: 'effect' },
  'fx-pr-merge':       { path: ASSET_BASE + 'sprites/effects/github-pr-merge.webp', width: 24, height: 24, category: 'effect' },
  'fx-need-coffee':    { path: ASSET_BASE + 'sprites/effects/need-coffee.webp', width: 24, height: 24, category: 'effect' },
  'fx-rocket':         { path: ASSET_BASE + 'sprites/effects/rocket.webp', width: 24, height: 24, category: 'effect' },
  'fx-sleeping':       { path: ASSET_BASE + 'sprites/effects/sleeping.webp', width: 24, height: 24, category: 'effect' },
  'fx-star':           { path: ASSET_BASE + 'sprites/effects/star.webp', width: 24, height: 24, category: 'effect' },
  'fx-thumb-up':       { path: ASSET_BASE + 'sprites/effects/thumb-up.webp', width: 24, height: 24, category: 'effect' },
  'fx-typing':         { path: ASSET_BASE + 'sprites/effects/typing.webp', width: 24, height: 24, category: 'effect' },

  // === ROOMS ===
  'room-office-day':   { path: ASSET_BASE + 'rooms/office-day.webp', width: 800, height: 600, category: 'room' },
  'room-office-night': { path: ASSET_BASE + 'rooms/office-night.webp', width: 800, height: 600, category: 'room' },
}

// Helper: get asset by key, returns path or fallback
export function getAssetPath(key: string): string | null {
  return ASSETS[key]?.path ?? null
}

// Helper: get all assets by category
export function getAssetsByCategory(category: SpriteAsset['category']): Record<string, SpriteAsset> {
  return Object.fromEntries(
    Object.entries(ASSETS).filter(([, a]) => a.category === category)
  )
}

// Helper: check if an asset exists in the manifest
export function hasAsset(key: string): boolean {
  return key in ASSETS
}
