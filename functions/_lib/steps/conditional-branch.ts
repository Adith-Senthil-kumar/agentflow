import { PermanentError } from '../retry';
import type { BranchAction, ComparisonOperator, ConditionalBranchConfig } from '../types';
import type { StepExecutor } from './types';

function asString(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function compare(
  left: unknown,
  operator: ComparisonOperator,
  right: unknown,
): boolean {
  const l = asString(left);
  const r = asString(right);

  switch (operator) {
    case 'contains':
      return l.toLowerCase().includes(r.toLowerCase());
    case 'not_contains':
      return !l.toLowerCase().includes(r.toLowerCase());
    case 'equals':
      return l.trim().toLowerCase() === r.trim().toLowerCase();
    case 'not_equals':
      return l.trim().toLowerCase() !== r.trim().toLowerCase();
    case 'gt':
      return Number(l) > Number(r);
    case 'lt':
      return Number(l) < Number(r);
    case 'matches':
      try {
        return new RegExp(r, 'i').test(l);
      } catch {
        throw new PermanentError(`conditional_branch has an invalid regex: ${r}`);
      }
    case 'is_empty':
      return l.trim() === '';
    case 'is_not_empty':
      return l.trim() !== '';
    default:
      throw new PermanentError(`Unsupported operator: ${operator as string}`);
  }
}

const DEFAULT_TRUE: BranchAction = { action: 'continue' };
const DEFAULT_FALSE: BranchAction = { action: 'continue' };

/**
 * if/else on the previous step's output.
 *
 * `left` is a template resolved before this runs, so it is normally something
 * like `{{last.text}}`. The chosen BranchAction is handed back to the executor,
 * which is what actually moves the cursor and marks any jumped-over steps as
 * `skipped` — so the branch that was *not* taken is visible in the run timeline
 * rather than silently absent.
 */
export const executeConditionalBranch: StepExecutor = async ({ config, onAttempt }) => {
  const cfg = config as unknown as ConditionalBranchConfig;

  if (!cfg.operator) {
    throw new PermanentError('conditional_branch requires an `operator` in its config');
  }

  await onAttempt(1);

  const result = compare(cfg.left, cfg.operator, cfg.right);
  const branch = result
    ? (cfg.on_true ?? DEFAULT_TRUE)
    : (cfg.on_false ?? DEFAULT_FALSE);

  return {
    output: {
      evaluated: `${asString(cfg.left).slice(0, 200)} ${cfg.operator} ${asString(cfg.right)}`,
      result,
      branch_taken: result ? 'on_true' : 'on_false',
      next: branch,
    },
    branch,
  };
};
