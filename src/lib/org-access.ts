import 'server-only';
import { gqlAdmin } from './hasura';
import type { OrgRole, StepType, TriggerType } from './types';

/**
 * Raised when a caller is not permitted to do something. The message is
 * deliberately identical whether the target does not exist or exists in
 * another org: a distinguishable "not found" vs "forbidden" would let an Org B
 * user confirm the existence of an Org A workflow by guessing ids.
 */
export class AccessDenied extends Error {
  constructor(message = 'Not found, or you do not have access to it') {
    super(message);
    this.name = 'AccessDenied';
  }
}

/** The caller's role in a specific org, or null if they are not a member. */
export async function getOrgRole(
  userId: string,
  orgId: string,
): Promise<OrgRole | null> {
  const data = await gqlAdmin<{ org_members: { role: OrgRole }[] }>(
    `query OrgRole($userId: uuid!, $orgId: uuid!) {
       org_members(where: {user_id: {_eq: $userId}, org_id: {_eq: $orgId}}, limit: 1) {
         role
       }
     }`,
    { userId, orgId },
  );
  return data.org_members[0]?.role ?? null;
}

export async function assertOrgRole(
  userId: string | null,
  orgId: string,
  allowed: OrgRole[],
): Promise<OrgRole> {
  if (!userId) throw new AccessDenied();
  const role = await getOrgRole(userId, orgId);
  // Non-membership and insufficient-role collapse into the same error. A viewer
  // in Org A learns "you cannot do that"; a member of Org B learns nothing.
  if (!role || !allowed.includes(role)) throw new AccessDenied();
  return role;
}

/**
 * Layer 2, handler side.
 *
 * The Hasura insert permission already blocks an editor from adding a db_write
 * or notify step. This re-derives the same rule from `step_types.owner_only`
 * for code paths that run as admin — where row permissions do not apply — so
 * the gate holds even when a step is created by the server rather than by a
 * client mutation.
 */
export async function assertCanUseStepType(
  userId: string | null,
  orgId: string,
  stepType: StepType,
): Promise<void> {
  const data = await gqlAdmin<{ step_types_by_pk: { owner_only: boolean } | null }>(
    `query StepTypeGate($value: String!) {
       step_types_by_pk(value: $value) { owner_only }
     }`,
    { value: stepType },
  );
  if (!data.step_types_by_pk) throw new AccessDenied(`Unknown step type: ${stepType}`);

  const allowed: OrgRole[] = data.step_types_by_pk.owner_only
    ? ['owner']
    : ['owner', 'editor'];
  await assertOrgRole(userId, orgId, allowed);
}

export async function assertCanUseTriggerType(
  userId: string | null,
  orgId: string,
  triggerType: TriggerType,
): Promise<void> {
  const data = await gqlAdmin<{
    trigger_types_by_pk: { owner_only: boolean } | null;
  }>(
    `query TriggerTypeGate($value: String!) {
       trigger_types_by_pk(value: $value) { owner_only }
     }`,
    { value: triggerType },
  );
  if (!data.trigger_types_by_pk)
    throw new AccessDenied(`Unknown trigger type: ${triggerType}`);

  const allowed: OrgRole[] = data.trigger_types_by_pk.owner_only
    ? ['owner']
    : ['owner', 'editor'];
  await assertOrgRole(userId, orgId, allowed);
}
