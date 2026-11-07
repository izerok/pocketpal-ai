/**
 * Local API Server store — serves the phone's loaded local model over
 * HTTP on the LAN as an OpenAI-compatible API (v1).
 *
 * Foreground-only by design: the server lives with the app process, so
 * it stops when the app is backgrounded or killed. There is no
 * background service and no autostart in v1.
 *
 * Security posture: the server binds 0.0.0.0 (LAN) with no TLS, so the
 * Bearer token is the only gate. The token is generated on first start,
 * stored in the system Keychain (never in AsyncStorage), and the user
 * can regenerate it from Settings. The port is the only persisted
 * setting.
 */
import {makeAutoObservable, runInAction, toJS} from 'mobx';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {makePersistable} from 'mobx-persist-store';
import * as Keychain from 'react-native-keychain';
import DeviceInfo from 'react-native-device-info';
import {v4 as uuidv4} from 'uuid';
import 'react-native-get-random-values';

import {modelStore} from './ModelStore';
import {LocalCompletionEngine} from '../api/completionEngines';
import {startLocalApiServer} from '../api/localServer/server';
import type {LocalApiServerHandle} from '../api/localServer/server';
import {
  handleLocalApiRequest,
  LocalApiBusyError,
} from '../api/localServer/router';
import type {CompletionStreamData} from '../utils/completionTypes';
import {ModelOrigin} from '../utils/types';

export const DEFAULT_LOCAL_API_PORT = 8080;
export const LOCAL_API_KEYCHAIN_SERVICE = 'pocketpal-local-api-key';
const LOCAL_API_KEYCHAIN_USERNAME = 'local-api-key';

function clampPort(port: number): number {
  if (!Number.isFinite(port)) {
    return DEFAULT_LOCAL_API_PORT;
  }
  return Math.min(65535, Math.max(1024, Math.floor(port)));
}

class LocalApiServerStore {
  /** Persisted. */
  port: number = DEFAULT_LOCAL_API_PORT;

  /** Runtime only. */
  running = false;
  apiKey = '';
  localIp = '';
  requestsTotal = 0;
  requestsFailed = 0;
  lastError: string | null = null;
  startedAt: number | null = null;

  private serverHandle: LocalApiServerHandle | null = null;
  private keyLoaded = false;

  constructor() {
    makeAutoObservable(this);

    makePersistable(this, {
      name: 'LocalApiServerStore',
      properties: ['port'],
      storage: AsyncStorage,
    }).then(() => {
      runInAction(() => {
        this.port = clampPort(this.port);
      });
    });

    this.loadApiKeyFromSecureStorage();
  }

  get baseUrl(): string {
    return `http://${this.localIp || 'localhost'}:${this.port}`;
  }

  get statusText(): 'running' | 'stopped' | 'error' {
    if (this.lastError) {
      return 'error';
    }
    return this.running ? 'running' : 'stopped';
  }

  private async loadApiKeyFromSecureStorage(): Promise<void> {
    try {
      const credentials = await Keychain.getGenericPassword({
        service: LOCAL_API_KEYCHAIN_SERVICE,
      });
      if (credentials) {
        runInAction(() => {
          this.apiKey = credentials.password;
        });
      }
    } catch (error) {
      console.error('Failed to load local API key:', error);
    } finally {
      runInAction(() => {
        this.keyLoaded = true;
      });
    }
  }

  private async ensureApiKey(): Promise<string> {
    if (!this.keyLoaded) {
      // The constructor kicked off the Keychain read; wait a beat for it
      // instead of minting a second token over the stored one.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.apiKey) {
      return this.apiKey;
    }
    const token = uuidv4();
    await Keychain.setGenericPassword(LOCAL_API_KEYCHAIN_USERNAME, token, {
      service: LOCAL_API_KEYCHAIN_SERVICE,
    });
    runInAction(() => {
      this.apiKey = token;
    });
    return token;
  }

  /** Mint a fresh token. Takes effect for the next request. */
  async regenerateApiKey(): Promise<string> {
    const token = uuidv4();
    await Keychain.setGenericPassword(LOCAL_API_KEYCHAIN_USERNAME, token, {
      service: LOCAL_API_KEYCHAIN_SERVICE,
    });
    runInAction(() => {
      this.apiKey = token;
    });
    return token;
  }

  /**
   * Start listening. Starting without a loaded model is allowed: /v1/models
   * then lists nothing and chat completions answer 503 until a local model
   * is loaded.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    runInAction(() => {
      this.lastError = null;
    });
    const apiKey = await this.ensureApiKey();
    let ip = '';
    try {
      ip = await DeviceInfo.getIpAddress();
    } catch {
      ip = '';
    }
    runInAction(() => {
      this.localIp = ip;
    });

    try {
      const handle = await startLocalApiServer({
        port: this.port,
        onRequest: async (req, writer, signal) => {
          runInAction(() => {
            this.requestsTotal += 1;
          });
          const status = await handleLocalApiRequest(
            req,
            {
              apiKey: this.apiKey || apiKey,
              baseCompletionSettings: toJS(
                modelStore.activeModel?.completionSettings ?? {},
              ),
              getActiveModel: () => {
                const model = modelStore.activeModel;
                const engine = modelStore.engine;
                if (
                  !model ||
                  model.origin === ModelOrigin.REMOTE ||
                  !(engine instanceof LocalCompletionEngine)
                ) {
                  return null;
                }
                return {id: model.id};
              },
              isBusy: () => modelStore.isGenerationBusy,
              runCompletion: async (params, onToken) => {
                const lease = modelStore.tryAcquireGeneration();
                if (!lease) {
                  throw new LocalApiBusyError();
                }
                const stopOnAbort = () => {
                  lease.engine.stopCompletion().catch(() => {});
                };
                signal.addEventListener('abort', stopOnAbort, {once: true});
                try {
                  if (signal.aborted) {
                    throw new Error('Request aborted');
                  }
                  return await lease.engine.completion(
                    params,
                    (data: CompletionStreamData) => {
                      if (!signal.aborted) {
                        onToken(data);
                      }
                    },
                  );
                } finally {
                  signal.removeEventListener('abort', stopOnAbort);
                  lease.end();
                }
              },
            },
            writer,
            signal,
          );
          if (status >= 400) {
            runInAction(() => {
              this.requestsFailed += 1;
            });
          }
          return status;
        },
      });
      runInAction(() => {
        this.serverHandle = handle;
        this.running = true;
        this.startedAt = Date.now();
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to start the server';
      runInAction(() => {
        this.lastError = message;
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.serverHandle) {
      return;
    }
    const handle = this.serverHandle;
    runInAction(() => {
      this.serverHandle = null;
      this.running = false;
      this.startedAt = null;
    });
    if (handle) {
      await handle.stop();
    }
  }
}

export const localApiServerStore = new LocalApiServerStore();
