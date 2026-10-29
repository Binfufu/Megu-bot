/**
 * Per-group message buffer and self-reply policy.
 *
 * The point of this module is to decouple "reading the group" from "calling the
 * model". Buffering a message costs nothing; only a reply does. So every group
 * message is recorded locally, and a model call happens only when someone @s the
 * bot, or when the self-reply policy below decides the group is worth one.
 *
 * Kept free of timers and I/O so the policy is directly testable.
 */

/** How a group buffer entry is rendered into the prompt. */
export function renderEntry(entry) {
  const name = entry.sender || '某人';
  const body = entry.content || (entry.hasImage ? '[图片]' : '[附件]');
  return `  ${name}：${body}`;
}

/**
 * Second-person markers that mean a message is talking *to* someone.
 *
 * Deliberately crude. It is only ever consulted while a conversation window is
 * open — i.e. right after the bot spoke — where "你" almost certainly means the
 * bot and not another member. Outside that window it is not used at all.
 */
export const DEFAULT_ADDRESS_MARKERS = ['你', '妳', '您', '汝'];

/** Whether a message appears to be addressed to the bot. */
export function looksAddressedToBot(text, markers = DEFAULT_ADDRESS_MARKERS) {
  if (typeof text !== 'string' || text === '') return false;
  return markers.some((marker) => typeof marker === 'string' && marker !== '' && text.includes(marker));
}

export class GroupContext {
  #buffers = new Map();
  #state = new Map();
  #windowUntil = new Map();

  /**
   * @param {object} config
   * @param {number} config.maxEntries      how many recent messages to keep
   * @param {number} config.maxAgeMs        drop entries older than this
   * @param {number} config.cooldownMs      gap between *unsolicited* replies
   * @param {number} config.engagedCooldownMs gap while the bot is being talked to
   * @param {number} config.minMessages     new messages required before speaking unprompted
   * @param {number} config.windowMs        how long a conversation stays "open"
   */
  constructor({
    maxEntries = 15,
    maxAgeMs = 10 * 60_000,
    cooldownMs = 120_000,
    engagedCooldownMs = 15_000,
    minMessages = 2,
    windowMs = 90_000,
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.cooldownMs = cooldownMs;
    this.engagedCooldownMs = engagedCooldownMs;
    this.minMessages = minMessages;
    this.windowMs = windowMs;
  }

  /** Append an observed message. Never triggers a model call. */
  record(groupId, { sender, content, hasImage }, now = Date.now()) {
    const entries = this.#buffers.get(groupId) ?? [];
    entries.push({ sender, content, hasImage, at: now });
    this.#buffers.set(groupId, entries);
    this.#prune(groupId, now);

    const state = this.#state.get(groupId) ?? { lastReplyAt: null, pending: 0 };
    state.pending += 1;
    this.#state.set(groupId, state);
  }

  /** Recent messages, oldest first, excluding anything past the age limit. */
  recent(groupId, now = Date.now()) {
    this.#prune(groupId, now);
    return [...(this.#buffers.get(groupId) ?? [])];
  }

  /** Render the buffer as a prompt block, or '' when there is nothing to say. */
  render(groupId, now = Date.now()) {
    const entries = this.recent(groupId, now);
    if (entries.length === 0) return '';
    return ['最近群里的消息（供你参考，不必逐条回应）：', ...entries.map(renderEntry)].join('\n');
  }

  /**
   * Whether a reply is allowed right now.
   *
   * @param {object} [options]
   * @param {boolean} [options.skipMinMessages] the message is aimed at the bot,
   *   so chatter volume is irrelevant.
   * @param {number} [options.cooldownMs] gap to enforce; callers pass the short
   *   engaged gap whenever a conversation is underway.
   */
  shouldSelfReply(groupId, now = Date.now(), { skipMinMessages = false, cooldownMs } = {}) {
    const state = this.#state.get(groupId);
    if (!state) return false;
    if (!skipMinMessages && state.pending < this.minMessages) return false;
    // `null` means the bot has never spoken here, so no cooldown applies. A
    // numeric sentinel would be ambiguous with a genuine timestamp of 0.
    if (state.lastReplyAt === null) return true;
    return now - state.lastReplyAt >= (cooldownMs ?? this.cooldownMs);
  }

  /**
   * Record that the bot just spoke, resetting the gates and opening the
   * conversation window. Every reply refreshes it, so an ongoing exchange keeps
   * itself open and lapses `windowMs` after the last thing the bot said.
   */
  noteReply(groupId, now = Date.now()) {
    this.#state.set(groupId, { lastReplyAt: now, pending: 0 });
    this.#windowUntil.set(groupId, now + this.windowMs);
  }

  /** Whether the bot spoke recently enough that a follow-up is likely aimed at it. */
  isWindowOpen(groupId, now = Date.now()) {
    const until = this.#windowUntil.get(groupId);
    return until !== undefined && now < until;
  }

  /**
   * Drop the buffered messages for a group.
   *
   * Called once a reply has folded them into that session's history: keeping
   * them would re-send the same context on every later turn.
   */
  clear(groupId) {
    this.#buffers.delete(groupId);
  }

  /** Diagnostics for the log line. */
  stats(groupId) {
    const state = this.#state.get(groupId);
    return {
      buffered: (this.#buffers.get(groupId) ?? []).length,
      pending: state?.pending ?? 0,
      lastReplyAt: state?.lastReplyAt ?? null,
    };
  }

  /**
   * Every group the bot has heard from.
   *
   * Cold-warmer scheduling needs this: a group it has never seen is one it is
   * not in, so there is nothing to warm.
   */
  knownGroups() {
    return [...new Set([...this.#buffers.keys(), ...this.#state.keys()])];
  }

  /** Timestamp of the newest observed message, or null if none is buffered. */
  lastActivityAt(groupId) {
    const entries = this.#buffers.get(groupId);
    return entries && entries.length > 0 ? entries[entries.length - 1].at : null;
  }

  #prune(groupId, now) {
    const entries = this.#buffers.get(groupId);
    if (!entries) return;
    const fresh = entries.filter((e) => now - e.at <= this.maxAgeMs);
    this.#buffers.set(groupId, fresh.slice(-this.maxEntries));
  }
}

/** Sentinel the model returns when it would rather stay quiet. */
export const SILENT_TOKEN = '[跳过]';

/**
 * Find the first configured keyword present in a message.
 *
 * A direct reference to the character ("惠惠", "爆裂魔法") is a much stronger
 * signal of intent than raw chatter volume, so it is allowed to skip the
 * message-count gate that a quiet group would otherwise never clear.
 *
 * @returns {string|null} the matched keyword, for logging, or null.
 */
export function matchesKeywords(text, keywords) {
  if (typeof text !== 'string' || text === '') return null;
  if (!Array.isArray(keywords) || keywords.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword === '') continue;
    if (haystack.includes(keyword.toLowerCase())) return keyword;
  }
  return null;
}

/**
 * Whether a reply should be suppressed because the model chose silence.
 *
 * Only ever applied to self-initiated replies: an explicit @ always deserves an
 * answer, even a short one.
 */
export function isSilentReply(text) {
  return typeof text === 'string' && text.trim().replace(/[。.!！]/g, '') === SILENT_TOKEN;
}
