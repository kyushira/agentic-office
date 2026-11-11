import { ASSET_BASE } from '../assetBase'
/**
 * EffectBubble — a small floating sprite that appears above a character.
 *
 * Renders one of the effect sprites from /public/sprites/effects/ and
 * animates it with a gentle bob so it feels alive.
 */

import React from 'react'
import ResilientImg from './ResilientImg'

interface EffectBubbleProps {
  /** Full path to the sprite, e.g. ASSET_BASE + 'sprites/effects/typing.webp' */
  src: string
  /** Accessible label */
  alt?: string
}

const EffectBubble: React.FC<EffectBubbleProps> = ({ src, alt = 'effect' }) => {
  return (
    <div className="effect-bubble">
      <ResilientImg
        src={src}
        alt={alt}
        className="effect-bubble-img"
        draggable={false}
      />
    </div>
  )
}

export default EffectBubble
