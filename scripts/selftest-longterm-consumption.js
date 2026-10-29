import fs from 'node:fs';
import vm from 'node:vm';
import { DIRECT_RESPONSE_NOTES, withStyleNudge } from '../src/style.js';
export function registerLongTermConsumptionTests({ test, assert }) {
  test('长期记忆消费:真实turnNotes必须等待异步检索，指纹到最终提示词且无Promise占位', async () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const begin = source.indexOf('  async function turnNotes('), end = source.indexOf('\n  /**', begin);
    assert.ok(begin >= 0 && end > begin);
    let resolve, entered = false;
    const pending = new Promise(r => { resolve = r; });
    const run = vm.runInNewContext(source.slice(begin, end) + '\nturnNotes', {
      DIRECT_RESPONSE_NOTES,
      config: { policy: { stats: { enabled: false }, growth: { enabled: false }, seriousGuard: true } },
      pendingStoryFor: () => null, companyTurnNote: () => null, affinityNote: () => 'affinity-control',
      describeFishingScene: () => null, readFishing: () => null, panelPromptNote: () => null,
      describeLedgerForPrompt: () => null, conversationKeyFor: () => 'isolated-key',
      longTermNote: async recall => { entered = true; assert.equal(recall.conversation, 'isolated-key'); return pending; },
      claimNote: () => null, turnPolicyFor: () => ({ suppressMood: true, suppressNudges: true }),
    });
    let finished = false;
    const notesPending = run(null, { content: 'remember context' }).then(notes => { finished = true; return notes; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(entered, true); assert.equal(finished, false, 'must await memory before returning notes');
    resolve('unique-longterm-consumer-fingerprint'); const notes = await notesPending;
    const prompt = withStyleNudge('user-control', notes);
    assert.match(prompt, /unique-longterm-consumer-fingerprint/); assert.match(prompt, /affinity-control/);
    assert.match(prompt, /user-control/); assert.doesNotMatch(prompt, /\[object Promise\]/);
    // Resolved null must not become a truthy Promise placeholder either.
    const nullRun = vm.runInNewContext(source.slice(begin, end) + '\nturnNotes', {
      DIRECT_RESPONSE_NOTES,
      config: { policy: { stats: { enabled: false }, growth: { enabled: false } } },
      pendingStoryFor: () => null, companyTurnNote: () => null, affinityNote: () => 'affinity-control',
      panelPromptNote: () => null, describeLedgerForPrompt: () => null,
      longTermNote: async () => null, claimNote: () => null,
      turnPolicyFor: () => ({ suppressMood: true, suppressNudges: true }),
    });
    const nullNotes = await nullRun(null, null);
    assert.deepEqual(Array.from(nullNotes), [...DIRECT_RESPONSE_NOTES, 'affinity-control']);
    assert.match(withStyleNudge('control', nullNotes), /affinity-control/,
      '空检索仍保留既有好感对照项，直接回应要求不能挤掉其他注入');
    assert.doesNotMatch(withStyleNudge('control', nullNotes), /Promise|null/);
  });
}
