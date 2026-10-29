import { archiveDue } from './memory-store.js';

/** A source scan failure must not disable an already-open memory database. */
export function startMemoryArchive(runner, onArchiveError) {
  try { runner(false); }
  catch (error) { onArchiveError(error); }
  return runner;
}

/** The bridge's synchronous archive tick. Failed scans never advance its watermark. */
export function createMemoryArchiveTick({ getRunner, everyMs, afterArchive, onArchiveError,
  onSummaryError, now = Date.now, lastAt = now() }) {
  return function memoryArchiveTick() {
    const runner = getRunner();
    if (!runner) return { status: 'disabled' };
    const at = now();
    if (!archiveDue(lastAt, at, everyMs)) return { status: 'not_due' };
    let result;
    try { result = runner(true); }
    catch (error) {
      onArchiveError(error);
      return { status: 'failed' };
    }
    lastAt = at;
    // Archive first: a summary must consume the just-imported turns.
    Promise.resolve().then(() => afterArchive()).catch(onSummaryError);
    return { status: 'completed', result };
  };
}
