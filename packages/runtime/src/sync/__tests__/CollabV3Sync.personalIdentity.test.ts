// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(new Event('open')); }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function config(personalMemberId: string, getJwt: () => Promise<ReturnType<typeof asPersonalJwt>>) {
  return {
    serverUrl: 'wss://sync.example.test',
    orgId: 'personal-org',
    personalMemberId: asPersonalMemberId(personalMemberId),
    getJwt,
  };
}

describe('CollabV3 personal identity boundary', () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it('refuses a personal JWT whose subject does not match the personal room identity', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const provider = createCollabV3Sync(config('personal-member', async () =>
      asPersonalJwt(jwtFor('team-member')),
    ));

    await expect(provider.connect('session-1')).rejects.toMatchObject({ code: 'AUTH_MISMATCH' });
    expect(FakeWebSocket.instances).toEqual([]);
    provider.disconnectAll();
  });

  it('refreshes the branded personal JWT while retaining the personal room identity', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const first = asPersonalJwt(jwtFor('personal-member'));
    const refreshed = asPersonalJwt(jwtFor('personal-member'));
    const getJwt = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed);
    const provider = createCollabV3Sync(config('personal-member', getJwt));

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.instances[0].url).toContain('org:personal-org:user:personal-member:index');
    expect(new URL(FakeWebSocket.instances[0].url).searchParams.get('token')).toBe(first);
    FakeWebSocket.instances[0].open();

    const connected = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(FakeWebSocket.instances[1].url).toContain('org:personal-org:user:personal-member:session:session-1');
    expect(new URL(FakeWebSocket.instances[1].url).searchParams.get('token')).toBe(refreshed);
    FakeWebSocket.instances[1].open();
    await connected;
    expect(getJwt).toHaveBeenCalledTimes(2);
    provider.disconnectAll();
  });
});
