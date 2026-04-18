/**
 * Approval routing helpers (temporary home).
 *
 * These functions pick an approver for a sensitive action and resolve the
 * DM messaging_group they should be delivered to. They're called only from
 * the approvals module.
 *
 * PR #5 moved the access-decision half of this file (canAccessAgentGroup +
 * AccessDecision) into src/modules/permissions/. The approver-picking half
 * stays here as a temporary shim — PR #7 relocates it into a new default
 * approvals-primitive module alongside the approvals re-tier.
 *
 * Tier note: this file lives in core but imports from the permissions
 * optional module. That's a deliberate temporary violation; see the module
 * contract + REFACTOR_PLAN open question #3.
 */
import {
  getAdminsOfAgentGroup,
  getGlobalAdmins,
  getOwners,
} from './modules/permissions/db/user-roles.js';
import { ensureUserDm } from './modules/permissions/user-dm.js';
import type { MessagingGroup } from './types.js';

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break rule (per model): prefer approvers reachable on the same channel
 * kind as the origin; else first in list. Resolution uses ensureUserDm,
 * which may trigger a platform openDM call on cache miss — that's how we
 * support cold DMs to users who have never messaged the bot.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  // Pass 1: approvers whose channel matches the origin (prefix on user id).
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  // Pass 2: any reachable approver, in order.
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}
