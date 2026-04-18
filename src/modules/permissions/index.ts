/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers a single inbound-gate via setInboundGate(). The gate owns:
 *   1. Sender resolution: parse the channel adapter's payload, derive a
 *      namespaced user id, and upsert the `users` row on first sight so
 *      role/access lookups land on a real record thereafter.
 *   2. Access decision: owners → global admins → scoped admins → members.
 *   3. Unknown-sender policy: strict drops; request_approval is a TODO
 *      (pending the `add_group_member` action kind).
 *   4. Audit trail: drops get logged into `dropped_messages`.
 *
 * Without this module: core's router defaults to allow-all (PR #2), every
 * message routes through, and no users table is needed. Drops are not
 * recorded anywhere. Admin commands inside the container fall back to
 * permissionless mode (see formatter.ts).
 */
import { setInboundGate, type InboundEvent, type InboundGateResult } from '../../router.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import { canAccessAgentGroup } from './access.js';
import { recordDroppedMessage } from './db/dropped-messages.js';
import { getUser, upsertUser } from './db/users.js';

function extractAndUpsertUser(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!getUser(userId)) {
    upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return userId;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: parsed.sender ?? null,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  if (mg.unknown_sender_policy === 'strict') {
    log.info('MESSAGE DROPPED — unknown sender (strict policy)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  if (mg.unknown_sender_policy === 'request_approval') {
    log.info('MESSAGE DROPPED — unknown sender (approval flow TODO)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  // 'public' should have been handled before the gate; fall through silently.
}

setInboundGate((event, mg, agentGroupId): InboundGateResult => {
  const userId = extractAndUpsertUser(event);

  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true, userId };
  }

  if (!userId) {
    handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event);
    return { allowed: false, userId: null, reason: 'unknown_user' };
  }

  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true, userId };
  }

  handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, userId, reason: decision.reason };
});
