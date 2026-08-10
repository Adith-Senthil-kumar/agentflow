import { gqlAdmin } from './hasura';
import type { OrgRole } from './types';

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
