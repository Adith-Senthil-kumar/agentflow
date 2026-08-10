/**
 * Shared vocabulary for the workflow engine.
 *
 * The definitions live under `functions/_lib` because that is where the
 * executor and the Action handlers are, and re-exporting keeps the frontend's
 * `@/lib/types` imports working against exactly one copy.
 */
export * from '../../functions/_lib/types';
