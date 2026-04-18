/**
 * Inbound message routing.
 *
 * Channel adapter event → resolve messaging group → pick agent → inbound
 * gate (if set) → resolve/create session → write messages_in → wake
 * container.
 *
 * Access model lives in the permissions module via `setInboundGate`. Without
 * the module, the gate is unset and every message routes through
 * (downstream code tolerates `userId=null`). Drops by policy are only
 * recorded when the permissions module is loaded; core just logs.
 */
import { getChannelAdapter } from './channels/channel-registry.js';
import { getMessagingGroupByPlatform, createMessagingGroup, getMessagingGroupAgents } from './db/messaging-groups.js';
import { startTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface InboundEvent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat' | 'chat-sdk';
    content: string; // JSON blob
    timestamp: string;
  };
}

/**
 * Inbound gate hook.
 *
 * The permissions module registers a gate that owns sender resolution +
 * access decision + unknown-sender policy + drop-audit recording. Without
 * a gate, core defaults to allow-all with `userId=null`.
 *
 * Takes the raw event so the gate can read sender fields from
 * `event.message.content`. Returns either allowed=true with a `userId`
 * (null if unresolved) or allowed=false with a reason; core drops on refusal.
 */
export type InboundGateResult =
  | { allowed: true; userId: string | null }
  | { allowed: false; userId: string | null; reason: string };

export type InboundGateFn = (event: InboundEvent, mg: MessagingGroup, agentGroupId: string) => InboundGateResult;

let inboundGate: InboundGateFn | null = null;

export function setInboundGate(fn: InboundGateFn): void {
  if (inboundGate) {
    log.warn('Inbound gate overwritten');
  }
  inboundGate = fn;
}

/**
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // 0. Apply the adapter's thread policy. Non-threaded adapters (Telegram,
  //    WhatsApp, iMessage, email) collapse threads to the channel.
  const adapter = getChannelAdapter(event.channelType);
  if (adapter && !adapter.supportsThreads) {
    event = { ...event, threadId: null };
  }

  // 1. Resolve messaging group
  let mg = getMessagingGroupByPlatform(event.channelType, event.platformId);

  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
  }

  // 2. Resolve agent groups wired to this messaging group.
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) {
    log.warn('MESSAGE DROPPED — no agent groups wired to this channel. Run setup register step to configure.', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return;
  }

  const match = pickAgent(agents, event);
  if (!match) {
    log.warn('MESSAGE DROPPED — no agent matched trigger rules', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
    });
    return;
  }

  // 3. Inbound gate (if the permissions module is loaded). Otherwise
  //    allow-all with userId=null — downstream code tolerates null.
  let userId: string | null = null;
  if (inboundGate) {
    const result = inboundGate(event, mg, match.agent_group_id);
    userId = result.userId;
    if (!result.allowed) {
      log.info('MESSAGE DROPPED — inbound gate refused', {
        messagingGroupId: mg.id,
        agentGroupId: match.agent_group_id,
        userId,
        reason: result.reason,
      });
      return;
    }
  }

  // 4. Resolve or create session.
  //
  // Adapter thread policy overrides the wiring's session_mode: if the adapter
  // is threaded, each thread gets its own session regardless of what the
  // wiring says. Agent-shared is preserved because it expresses a
  // cross-channel intent the adapter can't know about.
  //
  // Exception: DMs (is_group=0). Sub-threads within a DM are a UX affordance,
  // not a conversation boundary — treat the whole DM as one session and let
  // threadId flow through to delivery so replies land in the right sub-thread.
  let effectiveSessionMode = match.session_mode;
  if (adapter && adapter.supportsThreads && effectiveSessionMode !== 'agent-shared' && mg.is_group !== 0) {
    effectiveSessionMode = 'per-thread';
  }
  const { session, created } = resolveSession(match.agent_group_id, mg.id, event.threadId, effectiveSessionMode);

  // 5. Write message to session DB
  writeSessionMessage(session.agent_group_id, session.id, {
    id: event.message.id || generateId(),
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: event.platformId,
    channelType: event.channelType,
    threadId: event.threadId,
    content: event.message.content,
  });

  log.info('Message routed', {
    sessionId: session.id,
    agentGroup: match.agent_group_id,
    kind: event.message.kind,
    userId,
    created,
  });

  // 6. Show typing indicator while the agent processes.
  startTypingRefresh(session.id, session.agent_group_id, event.channelType, event.platformId, event.threadId);

  // 7. Wake container
  const freshSession = getSession(session.id);
  if (freshSession) {
    await wakeContainer(freshSession);
  }
}

/**
 * Pick the matching agent for an inbound event.
 * Currently: highest priority agent. Future: trigger rule matching.
 */
function pickAgent(agents: MessagingGroupAgent[], _event: InboundEvent): MessagingGroupAgent | null {
  // Agents are already ordered by priority DESC from the DB query
  // TODO: apply trigger_rules matching (pattern, mentionOnly, etc.)
  return agents[0] ?? null;
}
