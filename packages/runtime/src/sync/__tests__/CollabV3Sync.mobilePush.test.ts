// [ASTRA-ORCH]
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';
import { createCollabV3Sync } from '../CollabV3Sync';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn<(payload: string) => void>();
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function config() {
  return {
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    personalMemberId: asPersonalMemberId('user-1'),
    getJwt: async () => asPersonalJwt(jwtFor('user-1')),
    getDeviceInfo: () => ({
      deviceId: 'desktop-1',
      name: 'Desktop',
      type: 'desktop' as const,
      platform: 'windows',
      connectedAt: 1,
      lastActiveAt: 2,
      isFocused: true,
      status: 'active' as const,
    }),
  };
}

async function connectedProvider() {
  const provider = createCollabV3Sync(config());
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.send.mockClear();
  return { provider, socket };
}

describe('CollabV3 explicit mobile attention push', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps default pushes presence-routed and settles on send failure', async () => {
    const { provider, socket } = await connectedProvider();
    socket.send.mockImplementationOnce(() => { throw new Error('socket closed'); });
    const result = await provider.requestMobilePush!('session-1', 'Title', 'Body');
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: 'requestMobilePush', requestingDeviceId: 'desktop-1', force: false,
    });
    expect(result).toMatchObject({ accepted: false, rejection: 'no_ack' });
    provider.disconnectAll();
  });

  it('forces explicit attention without forging desktop presence and awaits the acknowledgement', async () => {
    const { provider, socket } = await connectedProvider();
    const pending = provider.requestMobilePush!('session-1', 'Title', 'Body', {
      force: true, reason: 'notify_explicit',
    });
    const frames = socket.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(frames.map((frame) => frame.type)).toEqual(['requestMobilePush']);
    expect(frames[0]).toMatchObject({ requestingDeviceId: 'desktop-1', force: true, reason: 'notify_explicit' });
    socket.onmessage?.({ data: JSON.stringify({
      type: 'mobilePushResult', requestId: frames[0].requestId, sessionId: 'session-1',
      accepted: true, attemptedCount: 1, deliveredCount: 1, skipped: [],
    }) } as MessageEvent);
    expect(await pending).toMatchObject({ accepted: true, deliveredCount: 1 });
    provider.disconnectAll();
  });
});
