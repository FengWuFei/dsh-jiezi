// Minimal RFC 6455 WebSocket server: text frames, ping/pong, close, and
// fragmented messages. The bridge only needs one small JSON channel, so this
// stays deliberately narrower than a general WebSocket implementation.
//
// It intentionally rejects binary frames, extensions, and subprotocols.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER_BYTES = 16 * 1024;

export function createWsServer({ server, path = '/device', maxPayload = 256 * 1024, onConnection }) {
  const clients = new Set();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      reject(socket, 404, 'Not Found');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (typeof key !== 'string' || version !== '13') {
      reject(socket, 400, 'Bad Request');
      return;
    }
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : url.searchParams.get('token');

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + '\r\n',
    );
    socket.setNoDelay(true);

    const connection = new WsConnection(socket, maxPayload);
    clients.add(connection);
    connection.onClose(() => clients.delete(connection));
    try {
      onConnection(connection, { token: token ?? null, query: url.searchParams });
    } catch (error) {
      connection.close(1011, 'connection failed');
      clients.delete(connection);
      if (error) process.stderr.write(`[jiezi-bridge] ws connection error: ${error.message}\n`);
    }
    if (head && head.length > 0) connection.feed(head);
  });

  return {
    clients,
    closeAll() {
      for (const client of clients) client.close(1001, 'bridge stopping');
    },
  };
}

function reject(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

class WsConnection {
  #socket;
  #maxPayload;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = null;
  #closed = false;
  #closeHandlers = [];
  #messageHandlers = [];
  #pingTimer;
  #alive = true;
  #closeCode = 1000;

  constructor(socket, maxPayload) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', () => this.#terminate());
    socket.on('close', () => this.#finish());
    this.#pingTimer = setInterval(() => {
      if (!this.#alive) {
        this.#terminate();
        return;
      }
      this.#alive = false;
      this.#sendFrame(0x9, Buffer.alloc(0));
    }, 30_000);
    this.#pingTimer.unref?.();
  }

  onMessage(handler) {
    this.#messageHandlers.push(handler);
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
  }

  send(value) {
    if (this.#closed) return false;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return this.#sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;
    this.#closeCode = code;
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.#sendFrame(0x8, payload);
    this.#terminate();
  }

  feed(chunk) {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const big = this.#buffer.readBigUInt64BE(2);
        if (big > BigInt(this.#maxPayload)) {
          this.close(1009, 'message too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > this.#maxPayload) {
        this.close(1009, 'message too large');
        return;
      }
      if (!masked) {
        this.close(1002, 'client frames must be masked');
        return;
      }
      if (this.#buffer.length < offset + 4 + length) return;
      const mask = this.#buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.#buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      this.#buffer = this.#buffer.subarray(offset + 4 + length);
      this.#handleFrame(fin, opcode, payload);
      if (this.#closed) return;
    }
  }

  #handleFrame(fin, opcode, payload) {
    this.#alive = true;
    if (opcode === 0x9) {
      this.#sendFrame(0xA, payload);
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      this.#sendFrame(0x8, payload.subarray(0, 2));
      this.close(code >= 1000 && code <= 4999 ? code : 1000, '');
      return;
    }
    if (opcode === 0x2) {
      this.close(1003, 'binary frames are not supported');
      return;
    }
    if (opcode === 0x1 || opcode === 0x0) {
      if (opcode === 0x1) {
        if (this.#fragmentOpcode !== null) {
          this.close(1002, 'interleaved fragments');
          return;
        }
        if (fin) {
          this.#dispatch(payload);
          return;
        }
        this.#fragmentOpcode = 0x1;
        this.#fragments = [payload];
        return;
      }
      if (this.#fragmentOpcode !== 0x1) {
        this.close(1002, 'unexpected continuation');
        return;
      }
      this.#fragments.push(payload);
      const total = this.#fragments.reduce((sum, part) => sum + part.length, 0);
      if (total > this.#maxPayload) {
        this.close(1009, 'message too large');
        return;
      }
      if (fin) {
        const complete = Buffer.concat(this.#fragments);
        this.#fragmentOpcode = null;
        this.#fragments = [];
        this.#dispatch(complete);
      }
      return;
    }
    this.close(1002, `unsupported opcode ${opcode}`);
  }

  #dispatch(payload) {
    let text;
    try {
      text = payload.toString('utf8');
    } catch {
      this.close(1007, 'invalid utf-8');
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.close(1007, 'invalid json');
      return;
    }
    for (const handler of this.#messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        process.stderr.write(`[jiezi-bridge] ws handler error: ${error.message}\n`);
      }
    }
  }

  #sendFrame(opcode, payload) {
    if (this.#socket.destroyed || this.#closed) return false;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.#socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      this.#terminate();
      return false;
    }
  }

  #terminate() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#pingTimer);
    this.#socket.destroy();
    this.#finish();
  }

  #finish() {
    if (this.#closeHandlers.length === 0) return;
    const handlers = this.#closeHandlers;
    this.#closeHandlers = [];
    for (const handler of handlers) {
      try {
        handler(this.#closeCode);
      } catch {
        // Closing is best effort.
      }
    }
  }
}

export { MAX_HEADER_BYTES };
