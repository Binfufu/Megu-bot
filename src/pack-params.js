/**
 * Content-owned tuning only. Deployment identity, keys, permissions, money and
 * paths never come from a content pack. Shared constraints also feed config's
 * catalogue; defaults stay at the existing runtime configuration boundary.
 */
import { defineParam, resolveParams } from './params.js';

export const PACK_PARAM_SPECS = Object.freeze({
  QQBOT_MOOD_TTL_MS: Object.freeze({ type: 'int', min: 1 }),
  QQBOT_MOOD_KAOMOJI_CHANCE: Object.freeze({ type: 'number', min: 0, max: 1 }),
  QQBOT_STYLE_NUDGES: Object.freeze({ type: 'int', min: 0 }),
  QQBOT_SPOKEN_MAX_CHARS: Object.freeze({ type: 'int', min: 0 }),
  QQBOT_SPOKEN_EMOJI_CHANCE: Object.freeze({ type: 'number', min: 0, max: 1 }),
  QQBOT_POKE_REPLY_CHANCE: Object.freeze({ type: 'number', min: 0, max: 1 }),
  QQBOT_FACE_REPLY_CHANCE: Object.freeze({ type: 'number', min: 0, max: 1 }),
});

export const PACK_PARAM_DEFINITIONS = Object.freeze(Object.entries(PACK_PARAM_SPECS)
  .map(([id, spec]) => defineParam({ id, ...spec, scope: 'runtime', emptyAsUnset: false })));

/** Returns typed data plus value-free provenance; unknown or unsafe keys throw. */
export function validatePackParams(params) {
  return resolveParams(PACK_PARAM_DEFINITIONS, { contentPack: params });
}
