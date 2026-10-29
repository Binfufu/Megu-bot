/**
 * Daily morning greeting.
 *
 * A fixed-time sibling of the group warmer: same tick, same "fire at most once
 * per target per day" guarantee, different prompt and an explicit target list
 * that mixes private chats with groups.
 *
 * The two scenes get different framing on purpose — a group greeting should stay
 * polite and general, while a private one is allowed to be familiar.
 */

/**
 * Parse `HH:MM` into `{hour, minute}`.
 * @returns {{hour: number, minute: number}|null} null when unset or malformed.
 */
export function parseMorningTime(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Local calendar day, used as the once-per-day key. */
export function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether the greeting is due right now for a target that last ran on `lastDate`.
 *
 * Fires inside a grace window rather than at an exact instant, so a bridge that
 * was starting up (or asleep) at the appointed minute still greets a little
 * later instead of silently skipping the day.
 *
 * @returns {'due'|'early'|'missed'|'done'} why it is or is not firing.
 */
export function morningStatus({ now, time, graceMs, lastDate }) {
  if (!time) return 'missed';
  const target = new Date(now);
  target.setHours(time.hour, time.minute, 0, 0);

  const since = now.getTime() - target.getTime();
  if (since < 0) return 'early';
  if (since >= graceMs) return 'missed';
  if (lastDate === localDateKey(now)) return 'done';
  return 'due';
}

/**
 * The greeting instruction for one scene.
 *
 * The group wording asks for a *general* greeting because a group contains
 * people the character has no relationship with; the private wording is
 * deliberately warmer. Both still defer to the character card for voice.
 */
export function buildMorningPrompt({ scene, context, silentToken }) {
  const lines = scene === 'c2c'
    ? [
        '[私聊] 现在是早上。你在跟一个关系很近的人说话。',
        '这次不用端着，放松一点：可以问他睡得好不好、吃早饭了没有，语气亲近、随意。',
        '一句到两句就够，别写成小作文，也别像客服。',
      ]
    : [
        '[群聊] 现在是早上，你可以跟大家打个招呼。',
        '群里有不熟的人，所以保持礼貌、自然、简短 —— 就是普通的早间问候。',
        '中二感收一点，别太热情，也别挨个点名。',
        '一句到两句就够。',
      ];

  return [
    ...lines,
    '',
    context,
    '',
    `如果这个时间开口不合适，就只回复 ${silentToken}。`,
  ].join('\n');
}
