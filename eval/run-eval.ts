/**
 * Category-classification and anomaly-flag eval.
 *
 * Runs every labelled receipt in receipts.eval.json through the real
 * ClaudeService and reports per-category precision / recall / F1, so a prompt
 * or taxonomy change can be measured instead of guessed at. Cases carrying an
 * `expected_suspicious` label are additionally scored on the anomaly flag.
 *
 *   npm run eval
 *   npm run eval -- --label before --out reports/before.json
 *   npm run eval -- --limit 5
 *
 * It calls the Claude API once per case, so it costs real tokens.
 */
import 'reflect-metadata';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HttpException, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ClaudeModule } from '../src/claude/claude.module';
import { ClaudeService } from '../src/claude/claude.service';

interface EvalCase {
  id: string;
  raw_text: string;
  expected_categories: string[];
  /**
   * Optional on purpose: only cases labelled for the anomaly flag are scored on
   * it, so the original category fixtures need no verdict invented for them.
   */
  expected_suspicious?: boolean;
  note?: string;
}

interface CaseResult {
  id: string;
  raw_text: string;
  expected: string[];
  got: string[];
  exact: boolean;
  missing: string[];
  spurious: string[];
  evidence?: string;
  expected_suspicious?: boolean;
  suspicious?: boolean;
  flag_reason?: string;
  error?: string;
}

/** Precision / recall over a single boolean prediction. */
interface FlagScore {
  labelled: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

interface CategoryScore {
  category: string;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Nest context without DatabaseModule, so the eval needs no PostgreSQL. */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ClaudeModule],
})
class EvalModule {}

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixturePath = join(__dirname, 'receipts.eval.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cases: EvalCase[];
  };
  const cases = options.limit
    ? fixture.cases.slice(0, options.limit)
    : fixture.cases;

  const app = await NestFactory.createApplicationContext(EvalModule, {
    logger: ['error'],
  });
  const claude = app.get(ClaudeService);

  process.stdout.write(
    `Running ${cases.length} cases against ${claude.model}${options.label ? ` [${options.label}]` : ''}\n`,
  );

  const results: CaseResult[] = new Array<CaseResult>(cases.length);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (next < cases.length) {
      const index = next++;
      results[index] = await runCase(claude, cases[index]);
      done++;
      process.stdout.write(`\r  ${done}/${cases.length} done`);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, cases.length) }, () => worker()),
  );
  process.stdout.write('\n\n');
  await app.close();

  const scores = score(results);
  report(results, scores, options.label);

  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(
      options.out,
      JSON.stringify(
        { label: options.label ?? null, model: claude.model, scores, results },
        null,
        2,
      ),
    );
    process.stdout.write(`Report written to ${options.out}\n`);
  }
}

/** Retries the transient upstream failures (429/502/503/504) the service maps. */
async function runCase(
  claude: ClaudeService,
  testCase: EvalCase,
): Promise<CaseResult> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const extracted = await claude.extractReceipt(testCase.raw_text);
      const got: string[] = [...extracted.categories].sort();
      const expected: string[] = [...testCase.expected_categories].sort();
      return {
        id: testCase.id,
        raw_text: testCase.raw_text,
        expected,
        got,
        exact: sameSet(expected, got),
        missing: expected.filter((c) => !got.includes(c)),
        spurious: got.filter((c) => !expected.includes(c)),
        evidence: extracted.category_evidence ?? undefined,
        expected_suspicious: testCase.expected_suspicious,
        suspicious: extracted.is_suspicious,
        flag_reason: extracted.flag_reason ?? undefined,
      };
    } catch (error) {
      const retryable =
        error instanceof HttpException &&
        [429, 502, 503, 504].includes(error.getStatus());
      if (!retryable || attempt === MAX_ATTEMPTS) {
        return {
          id: testCase.id,
          raw_text: testCase.raw_text,
          expected: [...testCase.expected_categories].sort(),
          got: [],
          exact: false,
          missing: [...testCase.expected_categories].sort(),
          spurious: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await sleep(1000 * attempt);
    }
  }
  throw new Error('unreachable');
}

/**
 * Scores the anomaly flag over the labelled cases only. An unlabelled case, or
 * one whose extraction failed, is neither a hit nor a miss - it simply is not
 * evidence about the flag, so it is excluded rather than counted as correct.
 */
function scoreFlags(results: CaseResult[]): FlagScore {
  const labelled = results.filter(
    (r) => r.expected_suspicious !== undefined && r.suspicious !== undefined,
  );

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const result of labelled) {
    if (result.expected_suspicious && result.suspicious) tp++;
    else if (result.suspicious) fp++;
    else if (result.expected_suspicious) fn++;
    else tn++;
  }

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    labelled: labelled.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1: f1(precision, recall),
    accuracy: ratio(tp + tn, labelled.length),
  };
}

function score(results: CaseResult[]): {
  categories: CategoryScore[];
  micro: { precision: number; recall: number; f1: number };
  exactMatchRate: number;
  flags: FlagScore;
  errors: number;
} {
  const categories = new Set<string>();
  for (const result of results) {
    result.expected.forEach((c) => categories.add(c));
    result.got.forEach((c) => categories.add(c));
  }

  const perCategory = [...categories]
    .map((category): CategoryScore => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const result of results) {
        const inExpected = result.expected.includes(category);
        const inGot = result.got.includes(category);
        if (inExpected && inGot) tp++;
        else if (inGot) fp++;
        else if (inExpected) fn++;
      }
      return {
        category,
        support: tp + fn,
        tp,
        fp,
        fn,
        precision: ratio(tp, tp + fp),
        recall: ratio(tp, tp + fn),
        f1: f1(ratio(tp, tp + fp), ratio(tp, tp + fn)),
      };
    })
    .sort(
      (a, b) => b.support - a.support || a.category.localeCompare(b.category),
    );

  const tp = perCategory.reduce((sum, s) => sum + s.tp, 0);
  const fp = perCategory.reduce((sum, s) => sum + s.fp, 0);
  const fn = perCategory.reduce((sum, s) => sum + s.fn, 0);
  const microPrecision = ratio(tp, tp + fp);
  const microRecall = ratio(tp, tp + fn);

  return {
    categories: perCategory,
    micro: {
      precision: microPrecision,
      recall: microRecall,
      f1: f1(microPrecision, microRecall),
    },
    exactMatchRate: ratio(
      results.filter((r) => r.exact).length,
      results.length,
    ),
    flags: scoreFlags(results),
    errors: results.filter((r) => r.error).length,
  };
}

function report(
  results: CaseResult[],
  scores: ReturnType<typeof score>,
  label?: string,
): void {
  const lines: string[] = [];
  lines.push(`=== Category classification${label ? ` [${label}]` : ''} ===`);
  lines.push('');
  lines.push(
    pad('category', 24) +
      pad('support', 9) +
      pad('P', 7) +
      pad('R', 7) +
      pad('F1', 7) +
      'tp/fp/fn',
  );
  lines.push('-'.repeat(72));
  for (const s of scores.categories) {
    lines.push(
      pad(s.category, 24) +
        pad(String(s.support), 9) +
        pad(pct(s.precision), 7) +
        pad(pct(s.recall), 7) +
        pad(pct(s.f1), 7) +
        `${s.tp}/${s.fp}/${s.fn}`,
    );
  }
  lines.push('-'.repeat(72));
  lines.push(
    pad('MICRO AVG', 24) +
      pad('', 9) +
      pad(pct(scores.micro.precision), 7) +
      pad(pct(scores.micro.recall), 7) +
      pad(pct(scores.micro.f1), 7),
  );
  lines.push('');
  lines.push(
    `Exact set match: ${pct(scores.exactMatchRate)} (${results.filter((r) => r.exact).length}/${results.length})   Errors: ${scores.errors}`,
  );

  lines.push('');
  lines.push('=== Anomaly flag ===');
  lines.push('');
  const flags = scores.flags;
  if (flags.labelled === 0) {
    lines.push(
      '  no labelled cases (add expected_suspicious to a case to score it)',
    );
  } else {
    lines.push(
      `  labelled: ${flags.labelled}   P ${pct(flags.precision)}   R ${pct(flags.recall)}   ` +
        `F1 ${pct(flags.f1)}   accuracy ${pct(flags.accuracy)}   tp/fp/fn/tn ${flags.tp}/${flags.fp}/${flags.fn}/${flags.tn}`,
    );

    const flagWrong = results.filter(
      (r) =>
        r.expected_suspicious !== undefined &&
        r.suspicious !== undefined &&
        r.expected_suspicious !== r.suspicious,
    );
    if (flagWrong.length > 0) {
      lines.push('');
      lines.push(`  Flag mismatches (${flagWrong.length}):`);
      for (const r of flagWrong) {
        lines.push('');
        lines.push(`    ${r.id}`);
        lines.push(`      text     : ${r.raw_text}`);
        lines.push(
          `      expected : ${String(r.expected_suspicious)}   got: ${String(r.suspicious)}`,
        );
        if (r.flag_reason) lines.push(`      reason   : ${r.flag_reason}`);
      }
    }
  }

  const wrong = results.filter((r) => !r.exact);
  if (wrong.length > 0) {
    lines.push('');
    lines.push(`Mismatches (${wrong.length}):`);
    for (const r of wrong) {
      lines.push('');
      lines.push(`  ${r.id}`);
      lines.push(`    text     : ${r.raw_text}`);
      lines.push(`    expected : ${r.expected.join(', ') || '(none)'}`);
      lines.push(`    got      : ${r.got.join(', ') || '(none)'}`);
      if (r.missing.length)
        lines.push(`    missing  : ${r.missing.join(', ')}`);
      if (r.spurious.length)
        lines.push(`    spurious : ${r.spurious.join(', ')}`);
      if (r.evidence) lines.push(`    evidence : ${r.evidence}`);
      if (r.error) lines.push(`    error    : ${r.error}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}

function parseArgs(argv: string[]): {
  label?: string;
  out?: string;
  limit?: number;
} {
  const options: { label?: string; out?: string; limit?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === '--label' && value) options.label = value;
    else if (argv[i] === '--out' && value) options.out = value;
    else if (argv[i] === '--limit' && value) options.limit = Number(value);
  }
  return options;
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;
const f1 = (precision: number, recall: number): number =>
  precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const pad = (value: string, width: number): string => value.padEnd(width);
const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

void main();
