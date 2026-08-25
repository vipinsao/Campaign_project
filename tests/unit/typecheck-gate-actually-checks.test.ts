/**
 * Proves the type-check gate is not a no-op.
 *
 * A `tsc` invocation that checks nothing exits 0 and looks exactly like a passing
 * check. It happens through an empty `files: []`, an `include` glob that stopped
 * matching after a directory rename, a build that goes through a bundler which
 * strips types instead of checking them, or a script that does not follow project
 * references. In every case CI turns green, the badge says the code type-checks,
 * and a whole class of defect walks straight into production for months.
 *
 * The only way to know a gate works is to break something on purpose and watch it
 * fail. So this test plants a file with a genuine type error INSIDE the project's
 * own include globs, runs the real `npm run typecheck`, and asserts a non-zero
 * exit. If someone later narrows the tsconfig so the gate stops covering the
 * source tree, this test goes red.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Inside packages/core/src, which tsconfig.json's `include` covers.
const PLANTED = path.join(ROOT, 'packages/core/src/__typecheck_probe__.ts');

const BROKEN = `// Planted by tests/unit/typecheck-gate-actually-checks.test.ts.
// If you are reading this in a diff, the test failed to clean up after itself.
export const definitelyAString: string = 42;
`;

async function typecheck(): Promise<number> {
  try {
    await run('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { cwd: ROOT });
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? 1;
  }
}

describe('the type-check gate', () => {
  it('passes on the real source tree', async () => {
    expect(await typecheck()).toBe(0);
  }, 180_000);

  it('FAILS when a broken file is planted inside its include globs', async () => {
    await writeFile(PLANTED, BROKEN, 'utf8');
    try {
      const code = await typecheck();
      expect(
        code,
        'tsc exited 0 with a deliberately broken file in packages/core/src. ' +
          'The type-check gate is not checking the source tree, and every green ' +
          'CI run to date has been meaningless.',
      ).not.toBe(0);
    } finally {
      await rm(PLANTED, { force: true });
    }
  }, 180_000);
});
