/**
 * Architectural invariants, asserted by scanning the source tree.
 *
 * These duplicate rules that ESLint also enforces, deliberately. A lint rule can
 * be disabled with a comment, reconfigured, or silently stop matching when a
 * directory is renamed — and when that happens nothing fails, which is the whole
 * problem. A test that reads the files and counts occurrences fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) yield full;
  }
}

async function sourceFiles(relDir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for await (const file of walk(path.join(ROOT, relDir))) {
    out.push({ path: path.relative(ROOT, file), text: await readFile(file, 'utf8') });
  }
  return out;
}

describe('the domain stays a domain', () => {
  it('never reads the wall clock (packages/core takes a Clock)', async () => {
    // SystemClock is the single permitted wall-clock read in the entire domain.
    // Naming the one exemption is the point: a blanket skip would let a second
    // one appear without anybody noticing.
    const PERMITTED = 'packages/core/src/clock.ts';

    const files = (await sourceFiles('packages/core')).filter((f) => f.path !== PERMITTED);
    const offenders: string[] = [];

    for (const file of files) {
      for (const [i, line] of file.text.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (code.includes('eslint-disable')) continue;
        if (/\bnew Date\(\s*\)/.test(code) || /\bDate\.now\(\s*\)/.test(code)) {
          offenders.push(`${file.path}:${i + 1}  ${line.trim()}`);
        }
      }
    }

    // And the exemption is exactly one line of CODE, so it cannot quietly grow.
    // The doc comment in that file names `new Date()` while explaining why it is
    // banned, so comments have to come out before counting.
    const clockSource = await readFile(path.join(ROOT, PERMITTED), 'utf8');
    const clockCode = clockSource
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .filter((l) => !/^\s*[*/]/.test(l))
      .join('\n');
    const wallClockReads = [...clockCode.matchAll(/\bnew Date\(\s*\)|\bDate\.now\(\s*\)/g)];
    expect(
      wallClockReads,
      `${PERMITTED} should contain exactly one wall-clock read (SystemClock.now)`,
    ).toHaveLength(1);

    expect(
      offenders,
      'core must take an injected Clock. A wall-clock read here makes "three days ' +
        'after delivery" a three-day test instead of a three-millisecond one:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('imports no vendor SDK outside packages/providers', async () => {
    // packages/triage is permitted @anthropic-ai/sdk; that boundary is asserted
    // separately, in the triage suite.
    const SDKS = ['nodemailer', 'postmark', 'twilio'];
    const files = [
      ...(await sourceFiles('packages/core')),
      ...(await sourceFiles('packages/shared')),
      ...(await sourceFiles('packages/api')),
      ...(await sourceFiles('packages/worker')),
      ...(await sourceFiles('packages/triage')),
    ];

    const offenders: string[] = [];
    for (const file of files) {
      for (const sdk of SDKS) {
        const importing = new RegExp(`(from|require\\()\\s*['"]${sdk}(/|['"])`);
        if (importing.test(file.text)) offenders.push(`${file.path} imports ${sdk}`);
      }
    }

    expect(
      offenders,
      'Vendor SDKs belong to packages/providers only. That boundary is what lets ' +
        'the entire domain be tested with no network and no credentials:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('has no hardcoded tenant identifier anywhere', async () => {
    const files = [...(await sourceFiles('packages')), ...(await sourceFiles('scripts'))];
    const UUID = /['"][0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}['"]/i;
    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of file.text.split('\n').entries()) {
        if (UUID.test(line)) offenders.push(`${file.path}:${i + 1}  ${line.trim()}`);
      }
    }
    expect(
      offenders,
      'Every query takes an explicit tenant. A hardcoded tenant constant is the ' +
        'thing a reviewer greps for first:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});

describe('I1 — there is exactly one send path', () => {
  it('calls provider.send from exactly one file', async () => {
    const files = [
      ...(await sourceFiles('packages/core')),
      ...(await sourceFiles('packages/api')),
      ...(await sourceFiles('packages/worker')),
      ...(await sourceFiles('scripts')),
    ];

    const callers = files
      .filter(
        (f) =>
          /\bprovider\.send\s*\(/.test(f.text) ||
          /\.send\(\s*\{[\s\S]{0,200}trackingId/.test(f.text),
      )
      .map((f) => f.path);

    expect(
      callers,
      'Every send goes through DeliveryOrchestrator.deliverClaimed, because a ' +
        'second send path is a send path with no gates in front of it. Found:\n' +
        callers.join('\n'),
    ).toEqual(['packages/core/src/delivery/orchestrator.ts']);
  });

  it('runs the full gate chain in a fixed, reviewable order', async () => {
    const { GATE_NAMES } = await import('@campaign/core');
    // The order is part of the contract. Consent and suppression must precede
    // quiet hours, because deferring a message for a contact who has opted out
    // would keep reconsidering a message that must never be sent.
    expect(GATE_NAMES).toEqual([
      'campaignStillActive',
      'enrollmentStillActive',
      'consentCurrent',
      'notSuppressed',
      'withinQuietHours',
      'underFrequencyCap',
      'hasValidRecipientAddress',
      'messageConditionSatisfied',
    ]);
  });
});
