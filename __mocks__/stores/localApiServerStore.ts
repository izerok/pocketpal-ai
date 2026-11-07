import {makeAutoObservable} from 'mobx';

class MockLocalApiServerStore {
  port = 8080;
  running = false;
  apiKey = 'test-api-key';
  localIp = '192.168.1.42';
  requestsTotal = 0;
  requestsFailed = 0;
  lastError: string | null = null;
  startedAt: number | null = null;

  get baseUrl(): string {
    return `http://${this.localIp || 'localhost'}:${this.port}`;
  }

  get statusText(): 'running' | 'stopped' | 'error' {
    if (this.lastError) {
      return 'error';
    }
    return this.running ? 'running' : 'stopped';
  }

  start: jest.Mock;
  stop: jest.Mock;
  regenerateApiKey: jest.Mock;

  constructor() {
    makeAutoObservable(this, {
      start: false,
      stop: false,
      regenerateApiKey: false,
    });
    this.start = jest.fn(() => {
      this.running = true;
      this.startedAt = Date.now();
      return Promise.resolve();
    });
    this.stop = jest.fn(() => {
      this.running = false;
      this.startedAt = null;
      return Promise.resolve();
    });
    this.regenerateApiKey = jest.fn(() => {
      this.apiKey = 'regenerated-test-key';
      return Promise.resolve(this.apiKey);
    });
  }
}

export const mockLocalApiServerStore = new MockLocalApiServerStore();
export const localApiServerStore = mockLocalApiServerStore;
