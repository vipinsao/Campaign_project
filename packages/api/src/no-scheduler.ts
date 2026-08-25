/**
 * The structural refusal to schedule  (see docs/ARCHITECTURE.md).
 *
 * The API runs behind a load balancer with N replicas. A recurring job registered
 * in this process therefore fires N times per tick: the queue drain claims three
 * batches, the nightly suppression-expiry sweep runs three times, and the mock
 * webhook drainer posts every callback three times. None of that fails loudly —
 * the symptom is duplicated sends and triplicated job_runs rows, which reads as a
 * worker bug rather than as a deployment topology mistake.
 *
 * A comment saying "do not add a scheduler here" is not a control, because the
 * person who adds one will be adding it in a hurry at the end of an afternoon and
 * will not read the comment. This module is the control: importing it arms a trap
 * on the two primitives every scheduler is ultimately built from, so a repeating
 * timer created by API code throws AT THE POINT OF REGISTRATION rather than
 * misbehaving quietly in production.
 *
 * Third-party libraries the API legitimately depends on — pg's pool reaper, pino's
 * flush timer, prom-client's event-loop-lag probe — create their timers from
 * frames inside node_modules and are left alone. The trap only fires for frames in
 * this repository's own source, plus anything whose module path looks like a cron
 * library regardless of where it lives.
 */

type IntervalFn = typeof globalThis.setInterval;

const SCHEDULER_MODULE_PATTERN =
  /node-cron|node_modules[/\\](cron|croner|agenda|bree|bull|toad-scheduler)[/\\]/i;
const OWN_SOURCE_PATTERN = /packages[/\\]api[/\\]src[/\\]/;

/** Registrations observed before the guard could refuse them. Read by the assertion. */
const observed: string[] = [];

let armed = false;
let original: IntervalFn | undefined;

/**
 * Which frame asked for this timer?
 *
 * The first two lines of the stack are this file, so they are dropped. The frame
 * that matters is the first one belonging to somebody else — attributing the timer
 * to `no-scheduler.ts` would make every violation look like it came from the
 * guard.
 */
function callSite(): string {
  const stack = new Error('scheduler-guard probe').stack ?? '';
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !line.includes('no-scheduler'));
  return frames.join('\n');
}

function isForbidden(frames: string): boolean {
  if (SCHEDULER_MODULE_PATTERN.test(frames)) return true;
  return OWN_SOURCE_PATTERN.test(frames.split('\n')[0] ?? '');
}

/**
 * Arm the trap. Idempotent, because a test that boots several apps in one process
 * would otherwise wrap the wrapper and multiply the stack-walk cost per timer.
 */
export function armSchedulerTrap(): void {
  if (armed) return;
  armed = true;
  original = globalThis.setInterval;
  const wrapped = ((handler: unknown, timeout?: number, ...args: unknown[]) => {
    const frames = callSite();
    if (isForbidden(frames)) {
      observed.push(frames);
      throw new Error(
        'packages/api registered a repeating timer. Schedulers belong to the worker ' +
          'process: three API replicas means every job fires three times. Move this to ' +
          `packages/worker.\n${frames}`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `original` is assigned on the line that set `armed`, and only this closure reads it
    return original!(handler as never, timeout, ...(args as never[]));
  }) as unknown as IntervalFn;

  globalThis.setInterval = wrapped;
}

/** Restore the real primitive. Exists so a test can assert the trap and then leave
 *  the process as it found it. */
export function disarmSchedulerTrap(): void {
  if (!armed || original === undefined) return;
  globalThis.setInterval = original;
  armed = false;
  observed.length = 0;
}

/**
 * Boot-time assertion.
 *
 * Throws if anything registered a repeating job while the module graph was being
 * evaluated. The trap itself throws at registration, so reaching this with a
 * non-empty census means someone caught and swallowed that throw — which is worth
 * failing the boot over rather than shrugging at.
 */
export function assertNoSchedulerRegistered(): void {
  if (!armed) {
    throw new Error(
      'The scheduler guard was never armed. packages/api/src/index.ts must import ' +
        './no-scheduler.ts before anything else, or the refusal is decorative.',
    );
  }
  if (observed.length > 0) {
    throw new Error(
      `packages/api registered ${observed.length} repeating job(s) at boot. The API ` +
        `process must not schedule; see packages/worker.\n${observed.join('\n---\n')}`,
    );
  }
}

export function schedulerCensus(): readonly string[] {
  return observed;
}

/**
 * Armed as a side effect of importing this module, and NOT from a call at the top
 * of index.ts.
 *
 * ES module imports are hoisted and every dependency is fully evaluated before a
 * single statement of the importing module runs. An `armSchedulerTrap()` call
 * written as the first line of index.ts would therefore execute AFTER every other
 * module in the graph had already been evaluated — after a module-scope
 * `cron.schedule(...)` had run. Arming here, from a module that index.ts imports
 * first, is the only placement where the trap exists before the code it is
 * watching.
 */
armSchedulerTrap();
