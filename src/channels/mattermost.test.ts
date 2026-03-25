import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MattermostChannel } from './mattermost.js';
import { ChannelOpts } from './registry.js';
import { Client4, WebSocketClient } from '@mattermost/client';
import { NewMessage } from '../types.js';
import { ASSISTANT_NAME } from '../config.js';

let mockClient4Instance: any;
let mockWsInstance: any;

vi.mock('@mattermost/client', () => {
    const Client4 = function() {
        mockClient4Instance = {
            setUrl: vi.fn(),
            setToken: vi.fn(),
            getMe: vi.fn().mockResolvedValue({ id: 'bot-id', username: 'test_bot' }),
            createPost: vi.fn().mockResolvedValue({}),
        };
        return mockClient4Instance;
    };
    const WebSocketClient = function() {
        mockWsInstance = {
            initialize: vi.fn(),
            setFirstConnectCallback: vi.fn(),
            setErrorCallback: vi.fn(),
            setCloseCallback: vi.fn(),
            setEventCallback: vi.fn(),
            close: vi.fn(),
            userTyping: vi.fn(),
            config: {},
        };
        return mockWsInstance;
    };
    return { Client4, WebSocketClient };
});

describe('MattermostChannel', () => {
    let opts: ChannelOpts;
    let channel: MattermostChannel;

    beforeEach(() => {
        vi.clearAllMocks();

        opts = {
            onMessage: vi.fn(),
            onChatMetadata: vi.fn(),
            registeredGroups: vi.fn().mockReturnValue({
                'mm:channel-123': { folder: 'mm-group', name: 'Mattermost Group' }
            }),
        };

        channel = new MattermostChannel('https://mattermost.example.com', 'test-token', opts);
    });

    it('has name "mattermost"', () => {
        expect(channel.name).toBe('mattermost');
    });

    it('owns JIDs starting with mm:', () => {
        expect(channel.ownsJid('mm:channel-123')).toBe(true);
        expect(channel.ownsJid('tg:123')).toBe(false);
    });

    it('connects to mattermost API and WebSocket', async () => {
        mockWsInstance.setFirstConnectCallback.mockImplementation((cb: Function) => {
            // Delay calling the callback so the promise can be setup
            setTimeout(cb, 0);
        });

        await channel.connect();

        expect(mockClient4Instance.setUrl).toHaveBeenCalledWith('https://mattermost.example.com');
        expect(mockClient4Instance.setToken).toHaveBeenCalledWith('test-token');
        expect(mockClient4Instance.getMe).toHaveBeenCalled();

        expect(mockWsInstance.initialize).toHaveBeenCalledWith('wss://mattermost.example.com/api/v4/websocket', 'test-token');
        expect(channel.isConnected()).toBe(true);
    });

    it('sets up proxy agent if proxyUrl is provided', () => {
        // We mock WebSocket temporarily, but since HttpsProxyAgent tries to initiate DNS/Sockets under the hood
        // we just verify that doFetch is successfully overridden. The actual request will be blocked by vitest anyway.
        const proxyChannel = new MattermostChannel('https://mattermost.example.com', 'test-token', opts, 'http://127.0.0.1:8080');
        expect(mockClient4Instance.doFetch).toBeDefined();
        expect(mockWsInstance.config.newWebSocketFn).toBeDefined();
    });

    it('sets up unauth agent if rejectUnauthorized is false', () => {
        const proxyChannel = new MattermostChannel('https://mattermost.example.com', 'test-token', opts, undefined, false);
        expect(mockClient4Instance.doFetch).toBeDefined();
        expect(mockClient4Instance.doFetchWithResponse).toBeDefined();
    });

    it('handles incoming messages and respects @mentions', async () => {
        let eventCallback: Function | undefined;
        mockWsInstance.setEventCallback.mockImplementation((cb: Function) => {
            eventCallback = cb;
        });

        mockWsInstance.setFirstConnectCallback.mockImplementation((cb: Function) => setTimeout(cb, 0));
        await channel.connect();

        // Ensure event callback was registered
        expect(eventCallback).toBeDefined();

        // Simulate a normal message
        const normalEvent = {
            event: 'posted',
            data: {
                sender_name: 'user1',
                channel_type: 'O',
                channel_display_name: 'General',
                post: JSON.stringify({
                    id: 'post-1',
                    channel_id: 'channel-123',
                    user_id: 'user-1',
                    message: 'Hello world',
                    create_at: 1672531200000,
                })
            }
        };

        eventCallback!(normalEvent);

        expect(opts.onChatMetadata).toHaveBeenCalledWith('mm:channel-123', '2023-01-01T00:00:00.000Z', 'General', 'mattermost', true);
        expect(opts.onMessage).toHaveBeenCalledWith('mm:channel-123', expect.objectContaining({
            id: 'post-1',
            chat_jid: 'mm:channel-123',
            sender: 'user-1',
            sender_name: 'user1',
            content: 'Hello world',
            is_from_me: false,
        }));

        // Simulate a mention
        const mentionEvent = {
            event: 'posted',
            data: {
                sender_name: 'user2',
                channel_type: 'P',
                channel_display_name: 'Private Group',
                post: JSON.stringify({
                    id: 'post-2',
                    channel_id: 'channel-123',
                    user_id: 'user-2',
                    message: '@test_bot Hello',
                    create_at: 1672531201000,
                })
            }
        };

        eventCallback!(mentionEvent);

        expect(opts.onMessage).toHaveBeenCalledWith('mm:channel-123', expect.objectContaining({
            id: 'post-2',
            content: `@${ASSISTANT_NAME} @test_bot Hello`,
        }));
    });

    it('ignores own messages and messages from unregistered groups', async () => {
        let eventCallback: Function | undefined;
        mockWsInstance.setEventCallback.mockImplementation((cb: Function) => {
            eventCallback = cb;
        });

        mockWsInstance.setFirstConnectCallback.mockImplementation((cb: Function) => setTimeout(cb, 0));
        await channel.connect();

        const ownMessageEvent = {
            event: 'posted',
            data: {
                post: JSON.stringify({
                    id: 'post-3',
                    channel_id: 'channel-123',
                    user_id: 'bot-id', // Same as getMe().id
                    message: 'My own message',
                    create_at: 1672531202000,
                })
            }
        };

        eventCallback!(ownMessageEvent);

        const unregisteredEvent = {
            event: 'posted',
            data: {
                post: JSON.stringify({
                    id: 'post-4',
                    channel_id: 'channel-456', // Not in registeredGroups
                    user_id: 'user-3',
                    message: 'Unregistered group message',
                    create_at: 1672531203000,
                })
            }
        };

        eventCallback!(unregisteredEvent);

        // onMessage should not have been called for either event
        expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('sends messages through mattermost client', async () => {
        mockWsInstance.setFirstConnectCallback.mockImplementation((cb: Function) => setTimeout(cb, 0));
        await channel.connect();

        await channel.sendMessage('mm:channel-123', 'Response text');

        expect(mockClient4Instance.createPost).toHaveBeenCalledWith({
            channel_id: 'channel-123',
            message: 'Response text',
        });
    });
});
