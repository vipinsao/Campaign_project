import { SystemClock, getPool } from '@campaign/core';
import { MockModelClient } from '../model-client.ts';
import { getLatestPrompt, getPrompt, syncPrompts } from '../prompts.ts';
import { evalExitCode, renderEvalReport, runEval } from './runner.ts';

/**
 * `tsx packages/triage/src/eval/cli.ts <prompt-name> [version] [dataset]`
 *
 * The executable end of the gate. It exists so that the CI step is one line and
 * the non-zero exit is real rather than described:
 *
 *   - run: npx tsx packages/triage/src/eval/cli.ts reply-classification
 *
 * It runs on MockModelClient, replaying recorded fixtures, so it needs no API key
 * and costs nothing. That is what makes it affordable to run on every commit — see
 * RecordingModelClient in model-client.ts for the argument.
 *
 * Output goes to stderr because stdout in this repository is reserved for machine
 * -readable output, and because a CI log reader wants the report interleaved with
 * the failure rather than buffered separately.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const name = argv[0] ?? 'reply-classification';
  const version = argv[1] === undefined ? undefined : Number(argv[1]);
  const dataset = argv[2] ?? 'reply-classification';
  const tenantId = process.env['EVAL_TENANT_ID'];

  if (!tenantId) {
    console.error(
      'EVAL_TENANT_ID is not set. An eval run executes the real pipeline, which reads ' +
        'that tenant’s confidence threshold and charges its token budget.',
    );
    return 2;
  }

  const db = getPool();
  const clock = new SystemClock();
  await syncPrompts(db);

  const prompt = version === undefined ? await getLatestPrompt(db, name) : await getPrompt(db, name, version);
  if (!prompt) {
    console.error(`No prompt '${name}'${version === undefined ? '' : ` v${version}`} on disk or in the prompts table.`);
    return 2;
  }

  const result = await runEval(
    {
      db,
      clock,
      tenantId,
      prompt,
      model: await MockModelClient.fromDisk(),
      ...(process.env['GITHUB_SHA'] === undefined ? {} : { gitSha: process.env['GITHUB_SHA'] }),
    },
    { dataset },
  );

  console.error(renderEvalReport(result));
  return evalExitCode(result);
}
