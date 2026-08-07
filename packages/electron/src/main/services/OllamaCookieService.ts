/**
 * OllamaCookieService - Manages Ollama session cookie storage.
 *
 * The Ollama Cloud account-usage API (OllamaUsageService.ts) provides live
 * usage percentages but no reset timestamps. The reset times are available on
 * ollama.com/settings, but only to authenticated sessions (WorkOS AuthKit
 * session cookie, NOT the OLLAMA_API_KEY used for the live percentage). This
 * service handles:
 * - Securely storing the `wos-session` cookie using Electron's safeStorage
 * - Retrieving it for OllamaResetTimeScraper.ts to fetch the reset times
 * - Falling back to a logged warning if safeStorage is unavailable (e.g., on
 *   Linux in certain desktop environments)
 *
 * The cookie is acquired via a settings text field (step 3), NOT via embedded
 * browser automation, so this service only manages persistence. The scraper
 * uses this cookie to authenticate the fetch of ollama.com/settings.
 *
 * Security notes:
 * - Cookie is encrypted using Electron's OS keychain (Windows: DPAPI,
 *   macOS: Keychain, Linux: fallback)
 * - Never logged or exposed in plaintext
 * - Can be cleared by the user from settings
 * - Mirrors CredentialService.ts pattern exactly
 */

import { safeStorage } from 'electron';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface OllamaCookie {
  cookie: string;
  storedAt: number;
}

const COOKIE_FILE = 'ollama-cookie.enc';

let cachedCookie: OllamaCookie | null = null;

/**
 * Get the path to the encrypted cookie file.
 */
function getCookiePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, COOKIE_FILE);
}

/**
 * Check if safeStorage is available for encryption.
 */
function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Save cookie to disk using safeStorage encryption.
 */
function saveCookie(cookie: string): void {
  const cookiePath = getCookiePath();
  const data: OllamaCookie = {
    cookie,
    storedAt: Date.now(),
  };
  const jsonData = JSON.stringify(data);

  if (isSafeStorageAvailable()) {
    // Encrypt using OS keychain
    const encrypted = safeStorage.encryptString(jsonData);
    fs.writeFileSync(cookiePath, encrypted);
    logger.main.info('[OllamaCookieService] Cookie saved with safeStorage encryption');
  } else {
    // Fallback: save as plain JSON (with warning)
    logger.main.warn('[OllamaCookieService] safeStorage not available - saving cookie without encryption');
    fs.writeFileSync(cookiePath, jsonData, 'utf8');
  }

  // Update cache
  cachedCookie = data;
}

/**
 * Load cookie from disk using safeStorage decryption.
 */
function loadCookie(): OllamaCookie | null {
  const cookiePath = getCookiePath();

  if (!fs.existsSync(cookiePath)) {
    return null;
  }

  try {
    const fileData = fs.readFileSync(cookiePath);

    if (isSafeStorageAvailable()) {
      // Decrypt using OS keychain
      const decrypted = safeStorage.decryptString(fileData);
      return JSON.parse(decrypted);
    } else {
      // Fallback: try to read as plain JSON
      const jsonData = fileData.toString('utf8');
      return JSON.parse(jsonData);
    }
  } catch (error) {
    logger.main.error('[OllamaCookieService] Failed to load cookie:', error);
    return null;
  }
}

/**
 * Get the stored Ollama session cookie, if available.
 * Returns null if no cookie has been configured.
 */
export function getOllamaCookie(): string | null {
  // Return cached cookie if available
  if (cachedCookie) {
    return cachedCookie.cookie;
  }

  // Try to load from disk
  const stored = loadCookie();
  if (stored) {
    cachedCookie = stored;
    logger.main.debug('[OllamaCookieService] Loaded Ollama session cookie from storage', {
      storedAt: new Date(stored.storedAt).toISOString(),
    });
    return stored.cookie;
  }

  return null;
}

/**
 * Store an Ollama session cookie.
 * Typically called from settings UI when user provides a `wos-session` cookie value.
 */
export function setOllamaCookie(cookie: string): void {
  if (!cookie || typeof cookie !== 'string') {
    throw new Error('Cookie must be a non-empty string');
  }

  logger.main.info('[OllamaCookieService] Storing new Ollama session cookie');
  saveCookie(cookie);
}

/**
 * Clear the stored Ollama session cookie.
 * Called when user explicitly clears it from settings, or on manual reset.
 */
export function clearOllamaCookie(): void {
  const cookiePath = getCookiePath();

  if (fs.existsSync(cookiePath)) {
    try {
      fs.unlinkSync(cookiePath);
      logger.main.info('[OllamaCookieService] Ollama session cookie cleared');
    } catch (error) {
      logger.main.error('[OllamaCookieService] Failed to clear cookie file:', error);
    }
  }

  cachedCookie = null;
}

/**
 * Check if a cookie is currently stored.
 */
export function hasOllamaCookie(): boolean {
  if (cachedCookie) return true;
  return fs.existsSync(getCookiePath());
}

/**
 * Check if safeStorage encryption is being used for the cookie.
 */
export function isUsingSecureStorage(): boolean {
  return isSafeStorageAvailable();
}
