/**
 * Controllable fake for `react-native-tcp-socket` (Jest only).
 *
 * Tests drive it by hand: grab the server from `__servers`, build a
 * `__FakeSocket`, call the recorded connection handler, then emit
 * `data` events and read what the server wrote.
 */
export class __FakeSocket {
  handlers = {};
  written = [];
  ended = false;
  destroyed = false;
  encoding = undefined;

  setEncoding(encoding) {
    this.encoding = encoding;
    return this;
  }

  on(event, cb) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(cb);
    return this;
  }

  emit(event, ...args) {
    (this.handlers[event] || []).forEach(cb => cb(...args));
  }

  write(data) {
    this.written.push(String(data));
    return true;
  }

  end(data) {
    if (data !== undefined) {
      this.written.push(String(data));
    }
    this.ended = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class __FakeServer {
  constructor(connectionHandler) {
    this.connectionHandler = connectionHandler;
    this.handlers = {};
    this.listening = false;
  }

  on(event, cb) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(cb);
    return this;
  }

  emit(event, ...args) {
    (this.handlers[event] || []).forEach(cb => cb(...args));
  }

  listen(options, callbackOrHost, callback) {
    this.listenOptions = options;
    this.listening = true;
    const cb = typeof callbackOrHost === 'function' ? callbackOrHost : callback;
    this.emit('listening');
    if (cb) {
      cb();
    }
    return this;
  }

  getConnections(cb) {
    cb(null, 0);
    return this;
  }

  close(cb) {
    this.listening = false;
    if (cb) {
      cb();
    }
    return this;
  }

  address() {
    return {port: 8080, address: '0.0.0.0', family: 'IPv4'};
  }
}

export const __servers = [];

const TcpSocket = {
  createServer: jest.fn(handler => {
    const server = new __FakeServer(handler);
    __servers.push(server);
    return server;
  }),
  __FakeSocket,
  __servers,
};

export default TcpSocket;
