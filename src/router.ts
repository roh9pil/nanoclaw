/**
 * Inbound message routing for v2.
 *
 * Channel adapter event → resolve messaging group → resolve agent group
 * → resolve/create session → write messages_in → wake container
 */
import { getMessagingGroupByPlatform, createMessagingGroup, getMessagingGroupAgents } from './db/messaging-groups.js';
import { log } from './log.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import type { MessagingGroupAgent } from './types.js';

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
 * Route an inbound message from a channel adapter to the correct session.
 * Creates messaging group + session if they don't exist yet.
 */
export async function routeInbound(event: InboundEvent): Promise<void> {
  // 1. Resolve messaging group
  let mg = getMessagingGroupByPlatform(event.channelType, event.platformId);

  if (!mg) {
    // Auto-create messaging group (adapter already decided to forward this)
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: event.channelType,
      platform_id: event.platformId,
      name: null,
      is_group: 0,
      admin_user_id: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-created messaging group', {
      id: mgId,
      channelType: event.channelType,
      platformId: event.platformId,
    });
  }

  // 2. Resolve agent group via messaging_group_agents
  const agents = getMessagingGroupAgents(mg.id);
  if (agents.length === 0) {
    // This is a common fresh-install issue: channels work but no agent group
    // is wired to handle messages. Run setup/register to create the wiring.
    log.warn('MESSAGE DROPPED — no agent groups wired to this channel. Run setup register step to configure.', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return;
  }

  // Pick the best matching agent (highest priority, trigger matching in future)
  const match = pickAgent(agents, event);
  if (!match) {
    log.warn('MESSAGE DROPPED — no agent matched trigger rules', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
    });
    return;
  }

  // 3. Resolve or create session
  const { session, created } = resolveSession(match.agent_group_id, mg.id, event.threadId, match.session_mode);

  // 4. Write message to session DB
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
    created,
  });

  // 5. Wake container
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
