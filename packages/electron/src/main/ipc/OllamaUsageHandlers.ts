/**
 * IPC Handlers for Ollama Usage tracking and Cookie management
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { ollamaUsageService, OllamaUsageData } from '../services/OllamaUsageService';
import {
  getOllamaCookie,
  setOllamaCookie,
  clearOllamaCookie,
  hasOllamaCookie,
  isUsingSecureStorage,
} from '../services/OllamaCookieService';

export function registerOllamaUsageHandlers(): void {
  safeHandle('ollama-usage:get', async (): Promise<OllamaUsageData | null> => {
    try {
      const cached = ollamaUsageService.getCachedUsage();
      if (cached) {
        return cached;
      }
      return await ollamaUsageService.refresh();
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error getting usage:', error);
      return null;
    }
  });

  safeHandle('ollama-usage:refresh', async (): Promise<OllamaUsageData> => {
    try {
      return await ollamaUsageService.refresh();
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error refreshing usage:', error);
      throw error;
    }
  });

  safeHandle('ollama-usage:activity', async (): Promise<void> => {
    try {
      await ollamaUsageService.recordActivity();
    } catch (error) {
      logger.main.error('[OllamaUsageHandlers] Error recording activity:', error);
    }
  });

  // Cookie management handlers for settings UI
  safeHandle('ollama:get-cookie-status', async (): Promise<{ hasCookie: boolean; isSecure: boolean }> => {
    return {
      hasCookie: hasOllamaCookie(),
      isSecure: isUsingSecureStorage(),
    };
  });

  safeHandle('ollama:set-cookie', async (cookie: string): Promise<void> => {
    if (!cookie || typeof cookie !== 'string') {
      throw new Error('Cookie must be a non-empty string');
    }
    setOllamaCookie(cookie);
    logger.main.info('[OllamaUsageHandlers] Ollama session cookie stored');
  });

  safeHandle('ollama:clear-cookie', async (): Promise<void> => {
    clearOllamaCookie();
    logger.main.info('[OllamaUsageHandlers] Ollama session cookie cleared');
  });

  logger.main.info('[OllamaUsageHandlers] Ollama usage and cookie IPC handlers registered');
}
