import { Client4, WebSocketClient } from '@mattermost/client';
// @ts-ignore
import WebSocket from 'ws';
import fetch from 'node-fetch';
import https from 'https';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { CustomHttpsProxyAgent } from '../proxy.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

if (!global.WebSocket) {
    // @ts-ignore
    global.WebSocket = WebSocket;
}

export class MattermostChannel implements Channel {
  name = 'mattermost';

  private client: Client4;
  private ws: WebSocketClient;
  private opts: ChannelOpts;
  private token: string;
  private url: string;
  private myUserId: string | null = null;
  private myUsername: string | null = null;

  constructor(
      url: string,
      token: string,
      opts: ChannelOpts,
      proxyUrl?: string,
      rejectUnauthorized: boolean = true
  ) {
    this.url = url;
    this.token = token;
    this.opts = opts;

    this.client = new Client4();
    this.client.setUrl(this.url);
    this.client.setToken(this.token);

    let agent: CustomHttpsProxyAgent | undefined;
    if (proxyUrl) {
        agent = new CustomHttpsProxyAgent(proxyUrl, { rejectUnauthorized });
    }

    if (proxyUrl || !rejectUnauthorized) {
        // Override the internal doFetch to inject the node-fetch instance and agent
        // @ts-ignore
        this.client.doFetch = async (endpoint: string, options: any) => {
            const getOpts = this.client.getOptions(options) as any;
            if (agent) {
                getOpts.agent = agent;
            } else if (!rejectUnauthorized) {
                getOpts.agent = new https.Agent({ rejectUnauthorized });
            }

            // @ts-ignore
            const response = await fetch(endpoint, getOpts);
            const contentType = response.headers.get('Content-Type');
            if (contentType && contentType.includes('application/json')) {
                return response.json();
            }
            return response.text();
        };
        // @ts-ignore
        this.client.doFetchWithResponse = async (endpoint: string, options: any) => {
            const getOpts = this.client.getOptions(options) as any;
            if (agent) {
                getOpts.agent = agent;
            } else if (!rejectUnauthorized) {
                getOpts.agent = new https.Agent({ rejectUnauthorized });
            }
            // @ts-ignore
            const response = await fetch(endpoint, getOpts);
            const headers = new Map();
            response.headers.forEach((val, key) => headers.set(key, val));

            let data;
            const contentType = response.headers.get('Content-Type');
            if (contentType && contentType.includes('application/json')) {
                data = await response.json();
            } else {
                data = await response.text();
            }

            if (response.ok || options.ignoreStatus) {
                return { response, headers, data };
            }

            // @ts-ignore
            const msg = data.message || '';
            throw new Error(`Mattermost API Error: ${msg}`);
        };
    }

    this.ws = new WebSocketClient();
    if (agent) {
        // @ts-ignore
        this.ws.config.newWebSocketFn = (wsUrl: string) => {
            // @ts-ignore
            return new WebSocket(wsUrl, { agent });
        };
    } else if (!rejectUnauthorized) {
        // @ts-ignore
        this.ws.config.newWebSocketFn = (wsUrl: string) => {
            // @ts-ignore
            return new WebSocket(wsUrl, { rejectUnauthorized });
        };
    }
  }

  async connect(): Promise<void> {
    try {
      const me = await this.client.getMe();
      this.myUserId = me.id;
      this.myUsername = me.username;

      // Extract ws url
      let wsUrl = this.url;
      if (wsUrl.startsWith('https://')) {
          wsUrl = 'wss://' + wsUrl.slice(8);
      } else if (wsUrl.startsWith('http://')) {
          wsUrl = 'ws://' + wsUrl.slice(7);
      } else {
          wsUrl = 'wss://' + wsUrl;
      }
      if (!wsUrl.endsWith('/')) {
        wsUrl += '/';
      }
      wsUrl += 'api/v4/websocket';

      return new Promise((resolve, reject) => {
          this.ws.setFirstConnectCallback(() => {
              logger.info('Mattermost WebSocket connected');
              console.log(`\n  Mattermost bot: @${this.myUsername}`);
              console.log(`  Connected to ${this.url}\n`);
              resolve();
          });

          this.ws.setErrorCallback((err: any) => {
              logger.error({ err }, 'Mattermost WebSocket error');
              reject(err);
          });

          this.ws.setCloseCallback((...args: any) => {
              logger.warn({ args }, 'Mattermost WebSocket closed');
          });

          this.ws.setEventCallback((event: any) => {
              this.handleEvent(event);
          });

          this.ws.initialize(wsUrl, this.token);
      });
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Mattermost');
      throw err;
    }
  }

  private handleEvent(event: any) {
    if (event.event !== 'posted') {
      return;
    }

    let post;
    try {
        post = JSON.parse(event.data.post);
    } catch(err) {
        logger.error({err}, 'Failed to parse mattermost post');
        return;
    }

    if (!post || !post.id || !post.channel_id || !post.user_id) {
        return;
    }

    if (post.user_id === this.myUserId) {
        // Ignore own messages
        return;
    }

    const channelId = post.channel_id;
    const chatJid = `mm:${channelId}`;
    const sender = post.user_id;
    const senderName = event.data.sender_name || sender;
    const msgId = post.id;
    let content = post.message || '';
    const timestamp = new Date(post.create_at).toISOString();

    const channelType = event.data.channel_type;
    const isGroup = channelType === 'P' || channelType === 'O'; // P: Private, O: Public, D: Direct Message
    let chatName = event.data.channel_display_name;
    if (channelType === 'D') {
        chatName = senderName;
    }

    if (this.myUsername) {
        const mentionPattern = new RegExp(`@${this.myUsername}\\b`, 'i');
        if (mentionPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
        }
    }

    this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'mattermost',
        isGroup
    );

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Mattermost channel');
        return;
    }

    this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
    });

    logger.info({ chatJid, chatName, sender: senderName }, 'Mattermost message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this.myUserId) {
        logger.warn('Mattermost client not connected');
        return;
    }

    const channelId = jid.replace(/^mm:/, '');
    try {
        // limit is 16383 characters per message for mattermost according to docs, but we split at 4000 just to be safe
        const MAX_LENGTH = 4000;
        if (text.length <= MAX_LENGTH) {
            await this.client.createPost({
                channel_id: channelId,
                message: text,
            } as any);
        } else {
            for (let i = 0; i < text.length; i += MAX_LENGTH) {
                await this.client.createPost({
                    channel_id: channelId,
                    message: text.slice(i, i + MAX_LENGTH),
                } as any);
            }
        }
        logger.info({ jid, length: text.length }, 'Mattermost message sent');
    } catch (err) {
        logger.error({ jid, err }, 'Failed to send Mattermost message');
    }
  }

  isConnected(): boolean {
    return this.myUserId !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mm:');
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
        this.ws.close();
        this.myUserId = null;
        this.myUsername = null;
        logger.info('Mattermost WebSocket disconnected');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping || !this.myUserId) return;
    try {
        const channelId = jid.replace(/^mm:/, '');
        this.ws.userTyping(channelId, '');
    } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Mattermost typing indicator');
    }
  }
}

registerChannel('mattermost', (opts: ChannelOpts) => {
    const envVars = readEnvFile(['MATTERMOST_URL', 'MATTERMOST_TOKEN', 'HTTPS_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED']);
    const url = process.env.MATTERMOST_URL || envVars.MATTERMOST_URL || '';
    const token = process.env.MATTERMOST_TOKEN || envVars.MATTERMOST_TOKEN || '';
    const proxyUrl = process.env.HTTPS_PROXY || envVars.HTTPS_PROXY || undefined;

    // Default to true (safe), only disable if explicitly '0' or 'false'
    const rejectStr = process.env.NODE_TLS_REJECT_UNAUTHORIZED || envVars.NODE_TLS_REJECT_UNAUTHORIZED || '1';
    const rejectUnauthorized = rejectStr !== '0' && rejectStr.toLowerCase() !== 'false';

    if (!url || !token) {
        logger.warn('Mattermost: MATTERMOST_URL and MATTERMOST_TOKEN must be set');
        return null;
    }

    return new MattermostChannel(url, token, opts, proxyUrl, rejectUnauthorized);
});
