export interface ProviderSessionPersistenceEvent {
  sessionId: string;
  providerSessionId: string;
  waitUntil?: (persistence: Promise<void>) => void;
}

export type ProviderSessionPersistenceWriter = (
  sessionId: string,
  providerSessionId: string,
) => Promise<void>;

/**
 * Build the exact host listener used for provider-session durability fencing.
 * waitUntil receives the raw writer promise synchronously; logging/catching the
 * listener completion must never turn a failed durable write into provider
 * success.
 */
export function createProviderSessionPersistenceHandler(
  write: ProviderSessionPersistenceWriter,
  reportError: (error: unknown) => void,
): (event: ProviderSessionPersistenceEvent) => Promise<void> {
  return async (event) => {
    const persistence = write(event.sessionId, event.providerSessionId);
    event.waitUntil?.(persistence);
    try {
      await persistence;
    } catch (error) {
      reportError(error);
    }
  };
}
