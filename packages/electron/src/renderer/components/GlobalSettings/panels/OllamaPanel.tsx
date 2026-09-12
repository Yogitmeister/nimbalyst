import React, { useState } from 'react';

/**
 * OllamaPanel - Settings for Ollama Cloud integration.
 *
 * Provides:
 * - Cookie storage field for ollama.com session authentication (wos-session cookie)
 * - Cookie validation status
 * - Link to ollama.com/settings for manual cookie acquisition
 *
 * The cookie is needed for the reset-time scraper (OllamaResetTimeScraper.ts) to
 * fetch countdown timers from ollama.com/settings. The OLLAMA_API_KEY is separate
 * and configured via environment (not stored in Nimbalyst).
 */

export function OllamaPanel() {
  const [cookie, setCookie] = useState('');
  const [hasCookie, setHasCookie] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  React.useEffect(() => {
    // Load existing cookie status on mount
    window.electronAPI.invoke('ollama:get-cookie-status').then((status: { hasCookie: boolean }) => {
      setHasCookie(status.hasCookie);
      setIsLoading(false);
    });
  }, []);

  const handleSaveCookie = async () => {
    if (!cookie.trim()) {
      setMessage({ type: 'error', text: 'Please paste a cookie value' });
      return;
    }

    setIsSaving(true);
    try {
      await window.electronAPI.invoke('ollama:set-cookie', cookie);
      setHasCookie(true);
      setCookie('');
      setMessage({ type: 'success', text: 'Cookie saved securely' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to save cookie';
      setMessage({ type: 'error', text: errorMessage });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearCookie = async () => {
    try {
      await window.electronAPI.invoke('ollama:clear-cookie');
      setHasCookie(false);
      setMessage({ type: 'success', text: 'Cookie cleared' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to clear cookie';
      setMessage({ type: 'error', text: errorMessage });
    }
  };

  const handleOpenSettings = () => {
    window.electronAPI.openExternal('https://ollama.com/settings');
  };

  if (isLoading) {
    return (
      <div className="provider-panel flex flex-col">
        <div className="text-sm text-[var(--nim-text-muted)]">Loading...</div>
      </div>
    );
  }

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          Ollama Cloud
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Store your Ollama session cookie to enable reset-time gauges for session and weekly usage windows.
          Your OLLAMA_API_KEY (for live usage percentages) is read from the environment, not stored here.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          Session Cookie ({hasCookie ? 'Stored' : 'Not stored'})
        </h4>

        <div className="mb-3">
          <p className="text-sm text-[var(--nim-text-muted)] mb-3">
            The Ollama reset-time scraper needs a WorkOS session cookie (<code className="bg-[var(--nim-bg-secondary)] px-1.5 py-0.5 rounded text-xs font-mono">wos-session</code>) to fetch countdown timers.
            Copy your cookie from ollama.com/settings (Developer Tools → Application → Cookies → wos-session), then paste it below.
          </p>

          <div className="mb-3">
            <textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="Paste your wos-session cookie value here"
              className="w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] font-mono text-xs resize-none"
              rows={3}
            />
          </div>

          <div className="flex gap-2 mb-3">
            <button
              onClick={handleSaveCookie}
              disabled={isSaving || !cookie.trim()}
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-primary)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? 'Saving...' : 'Save Cookie'}
            </button>

            {hasCookie && (
              <button
                onClick={handleClearCookie}
                className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
              >
                Clear Cookie
              </button>
            )}
          </div>

          {message && (
            <div className={`text-sm px-3 py-2 rounded-md ${
              message.type === 'success'
                ? 'bg-green-500/10 text-green-500'
                : 'bg-red-500/10 text-red-500'
            }`}>
              {message.text}
            </div>
          )}
        </div>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          Get Your Cookie
        </h4>
        <p className="text-sm text-[var(--nim-text-muted)] mb-3">
          Visit your Ollama account settings to copy your session cookie:
        </p>
        <button
          onClick={handleOpenSettings}
          className="inline-flex items-center gap-2 py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
        >
          <span>Open ollama.com/settings</span>
          <span>→</span>
        </button>
      </div>

      <div className="provider-panel-section py-4 text-xs text-[var(--nim-text-muted)]">
        <strong>Security:</strong> The cookie is encrypted using your OS keychain and never sent to Nimbalyst's servers.
        It is only used locally to fetch reset times from ollama.com.
      </div>
    </div>
  );
}
