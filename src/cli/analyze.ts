/**
 * `racs analyze`: lint and plan one or more {@link PlanInput} documents from a JSON file,
 * the CI gate of the RACS (Remote Agent Context Store) CLI.
 *
 * Flags:
 * - `--input <path>` (required): JSON file holding one PlanInput object or an array of
 *   them.
 * - `--pricing <path>` (optional): JSON {@link PricingTable} keyed by model id, refines
 *   break-even math with real prices.
 *
 * Exit codes, gate-friendly by design:
 * - 0: every input planned, no error-severity finding anywhere.
 * - 1: at least one error-severity lint finding exists, the prompt change should not ship.
 * - 2: usage error, missing or unreadable or structurally invalid input files.
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import { createRACS } from '../core/createRACS.js';
import { RacsError } from '../errors.js';
import type { CacheDirective, CachePlan, LintFinding, PlanInput, PricingTable } from '../types.js';
import { flagPresent, parseArgs, readString } from './args.js';

/** Human-readable rendering of an unknown thrown value for error messages. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Formats counts for report prose without dragging float noise into the line. */
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) {
    return 'unreachable';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * One finding as the documented report line: `LINT <severity> <code> <segmentId?>
 * <message>`, the segment id omitted when the finding is not local to one segment.
 * Shared with `racs simulate`, which prints first-call findings in the same shape.
 */
export function formatFinding(finding: LintFinding): string {
  const parts = ['LINT', finding.severity, finding.code];
  if (finding.segmentId !== undefined) {
    parts.push(finding.segmentId);
  }
  parts.push(finding.message);
  return parts.join(' ');
}

/** One directive as a single compact report line, provider-faithful field order. */
function formatDirective(directive: CacheDirective): string {
  switch (directive.kind) {
    case 'breakpoint':
      return `breakpoint after '${directive.segmentId}' ttl ${directive.ttl}`;
    case 'routing-key':
      return `routing-key ${directive.key}${
        directive.retention !== undefined ? ` retention ${directive.retention}` : ''
      }`;
    case 'resource':
      return `resource ${directive.action} ${directive.resourceKey} ttl ${directive.ttlSeconds}s`;
    case 'none':
      return `none (${directive.reason})`;
  }
}

/** Reads and parses one JSON file, throwing a plain Error with a readable message. */
async function loadJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new Error(`cannot read '${path}': ${describe(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new Error(`'${path}' is not valid JSON: ${describe(error)}`);
  }
}

/**
 * Runs the analyze command, see the module-level contract.
 *
 * @param argv - Tokens after the `analyze` command word.
 * @returns Process exit code, 0 clean, 1 error findings, 2 usage error.
 */
export async function runAnalyze(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const inputPath = readString(args, 'input');
  if (inputPath === undefined || inputPath === '') {
    console.error('racs analyze: --input <path> is required.');
    return 2;
  }
  const pricingPath = readString(args, 'pricing');
  if (flagPresent(args, 'pricing') && (pricingPath === undefined || pricingPath === '')) {
    console.error('racs analyze: --pricing requires a file path value.');
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = await loadJson(inputPath);
  } catch (error: unknown) {
    console.error(`racs analyze: ${describe(error)}`);
    return 2;
  }
  const candidates: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (candidates.length === 0) {
    console.error(`racs analyze: '${inputPath}' holds an empty array, nothing to analyze.`);
    return 2;
  }

  let pricing: PricingTable | undefined;
  if (pricingPath !== undefined) {
    let table: unknown;
    try {
      table = await loadJson(pricingPath);
    } catch (error: unknown) {
      console.error(`racs analyze: ${describe(error)}`);
      return 2;
    }
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      console.error(
        `racs analyze: '${pricingPath}' must hold a JSON object keyed by model id ` +
          `(a PricingTable).`,
      );
      return 2;
    }
    pricing = table as PricingTable;
  }

  const racs = createRACS({ ...(pricing !== undefined ? { pricing } : {}) });
  const lines: string[] = [];
  let errors = 0;
  let warnings = 0;
  let withDirectives = 0;
  let withoutDirectives = 0;

  for (const [index, candidate] of candidates.entries()) {
    let lintFindings: readonly LintFinding[];
    let plan: CachePlan;
    try {
      const input = candidate as PlanInput;
      lintFindings = racs.lint(input);
      plan = racs.plan(input);
    } catch (error: unknown) {
      if (error instanceof RacsError && error.code === 'ERR_INVALID_INPUT') {
        console.error(
          `racs analyze: input ${index + 1} in '${inputPath}' is not a valid PlanInput: ` +
            error.message,
        );
        return 2;
      }
      throw error;
    }

    // Plan findings are the lint findings plus planner-stage extras, so the lint pass and
    // the planning pass both contribute to the printed report without duplication.
    const findings: readonly LintFinding[] = [
      ...lintFindings,
      ...plan.findings.slice(lintFindings.length),
    ];

    lines.push(`input ${index + 1}: ${plan.provider}/${plan.model}`);
    lines.push(`  stable tokens: ${plan.stableTokens} of ${plan.totalTokens}`);
    for (const directive of plan.directives) {
      lines.push(`  directive: ${formatDirective(directive)}`);
    }
    for (const finding of findings) {
      lines.push(`  ${formatFinding(finding)}`);
      if (finding.severity === 'error') {
        errors += 1;
      } else if (finding.severity === 'warning') {
        warnings += 1;
      }
    }
    if (plan.breakEven !== undefined) {
      lines.push(
        `  break-even: ${formatTokens(plan.breakEven.writePremiumTokens)} premium tokens, ` +
          `${formatTokens(plan.breakEven.minReusesToProfit)} reuse(s) to profit, ` +
          `${plan.breakEven.profitable ? 'profitable' : 'not profitable'}`,
      );
    }
    if (plan.directives.some((directive) => directive.kind !== 'none')) {
      withDirectives += 1;
    } else {
      withoutDirectives += 1;
    }
  }

  lines.push('--- summary ---');
  lines.push(`inputs analyzed: ${candidates.length}`);
  lines.push(`errors: ${errors}`);
  lines.push(`warnings: ${warnings}`);
  lines.push(`plans with directives: ${withDirectives}`);
  lines.push(`plans without directives: ${withoutDirectives}`);
  console.log(lines.join('\n'));

  return errors > 0 ? 1 : 0;
}
