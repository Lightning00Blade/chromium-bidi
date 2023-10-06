/**
 * Copyright 2021 Google LLC.
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import http from 'http';

import debug from 'debug';
import websocket from 'websocket';

import type {ITransport} from '../utils/transport.js';
import {ErrorCode} from '../protocol/webdriver-bidi.js';

import type {CloseBrowserDelegate} from './index.js';

export const debugInfo = debug('bidi:server:info');
const debugInternal = debug('bidi:server:internal');
const debugSend = debug('bidi:server:SEND ▸');
const debugRecv = debug('bidi:server:RECV ◂');

export class BidiServerRunner {
  /**
   *
   * @param bidiPort port to start ws server on
   * @param onNewBidiConnectionOpen delegate to be called for each new
   * connection. `onNewBidiConnectionOpen` delegate should return another
   * `onConnectionClose` delegate, which will be called after the connection is
   * closed.
   */
  run(
    bidiPort: number,
    onNewBidiConnectionOpen: (
      bidiServer: ITransport,
      args?: string[]
    ) => Promise<CloseBrowserDelegate>
  ) {
    let jsonBody: any;
    const server = http.createServer(
      async (request: http.IncomingMessage, response: http.ServerResponse) => {
        debugInternal(
          `${new Date().toString()} Received ${
            request.method ?? 'UNKNOWN METHOD'
          } request for ${request.url ?? 'UNKNOWN URL'}`
        );
        if (!request.url) {
          return response.end(404);
        }

        // https://w3c.github.io/webdriver-bidi/#transport, step 2.
        if (request.url === '/session') {
          const body: Uint8Array[] = [];
          request
            .on('data', (chunk) => {
              body.push(chunk);
            })
            .on('end', () => {
              jsonBody = JSON.parse(Buffer.concat(body).toString());
              response.writeHead(200, {
                'Content-Type': 'application/json;charset=utf-8',
                'Cache-Control': 'no-cache',
              });
              response.write(
                JSON.stringify({
                  value: {
                    sessionId: '1',
                    capabilities: {
                      webSocketUrl: `ws://localhost:${bidiPort}`,
                    },
                  },
                })
              );
              return response.end();
            });
          return;
        } else if (request.url.startsWith('/session')) {
          debugInternal(
            `Unknown session command ${
              request.method ?? 'UNKNOWN METHOD'
            } request for ${
              request.url
            } with payload ${await BidiServerRunner.#getHttpRequestPayload(
              request
            )}. 200 returned.`
          );

          response.writeHead(200, {
            'Content-Type': 'application/json;charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          response.write(
            JSON.stringify({
              value: {},
            })
          );
        } else {
          debugInternal(
            `Unknown ${JSON.stringify(
              request.method
            )} request for ${JSON.stringify(
              request.url
            )} with payload ${JSON.stringify(
              await BidiServerRunner.#getHttpRequestPayload(request)
            )}. 404 returned.`
          );
          response.writeHead(404);
        }
        return response.end();
      }
    );
    server.listen(bidiPort, () => {
      debugInfo('BiDi server is listening on port', bidiPort);
    });

    const wsServer: websocket.server = new websocket.server({
      httpServer: server,
      autoAcceptConnections: false,
    });

    wsServer.on('request', async (request: websocket.request) => {
      const chromeOptions =
        jsonBody?.capabilities?.alwaysMatch?.['goog:chromeOptions'];
      debugInternal('new WS request received:', request.resourceURL.path);

      const transport = new MessageTransport();

      const closeBrowserDelegate: CloseBrowserDelegate =
        await onNewBidiConnectionOpen(transport, chromeOptions?.args);

      const connection = request.accept();

      connection.on('message', async (message) => {
        // If |type| is not text, return a error.
        if (message.type !== 'utf8') {
          this.#respondWithError(
            connection,
            {},
            ErrorCode.InvalidArgument,
            `not supported type (${message.type})`
          );
          return;
        }

        const plainCommandData = message.utf8Data;
        debugRecv(plainCommandData);

        // Try to parse the message to handle some of BiDi commands.
        let parsedCommandData: {id: number; method: string};
        try {
          parsedCommandData = JSON.parse(plainCommandData);
        } catch (e) {
          this.#respondWithError(
            connection,
            {},
            ErrorCode.InvalidArgument,
            `Cannot parse data as JSON`
          );
          return;
        }

        // Handle `browser.close` command.
        if (parsedCommandData.method === 'browser.close') {
          await closeBrowserDelegate();
          await this.#sendClientMessage(
            {
              id: parsedCommandData.id,
              type: 'success',
              result: {},
            },
            connection
          );
          return;
        }

        // Forward all other commands to BiDi Mapper.
        transport.onMessage(plainCommandData);
      });

      connection.on('close', async () => {
        debugInternal(
          `${new Date().toString()} Peer ${
            connection.remoteAddress
          } disconnected.`
        );
        // TODO: handle reconnection which is used in WPT. Until then, close the
        //  browser after each WS connection is closed.
        await closeBrowserDelegate();
      });

      transport.initialize((message) => {
        return this.#sendClientMessageString(message, connection);
      });
    });
  }

  #sendClientMessageString(
    message: string,
    connection: websocket.connection
  ): Promise<void> {
    debugSend(message);
    connection.sendUTF(message);
    return Promise.resolve();
  }

  #sendClientMessage(
    object: unknown,
    connection: websocket.connection
  ): Promise<void> {
    const json = JSON.stringify(object);
    return this.#sendClientMessageString(json, connection);
  }

  #respondWithError(
    connection: websocket.connection,
    plainCommandData: unknown,
    errorCode: string,
    errorMessage: string
  ) {
    const errorResponse = this.#getErrorResponse(
      plainCommandData,
      errorCode,
      errorMessage
    );
    void this.#sendClientMessage(errorResponse, connection);
  }

  #getErrorResponse(
    plainCommandData: any,
    errorCode: string,
    errorMessage: string
  ) {
    // XXX: this is bizarre per spec. We reparse the payload and
    // extract the ID, regardless of what kind of value it was.
    let commandId;
    try {
      const commandData = JSON.parse(plainCommandData);
      if ('id' in commandData) {
        commandId = commandData.id;
      }
    } catch {}

    return {
      type: 'error',
      id: commandId,
      error: errorCode,
      message: errorMessage,
      // XXX: optional stacktrace field.
    };
  }

  static #getHttpRequestPayload(
    request: http.IncomingMessage
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      request.on('data', (chunk) => {
        data += chunk;
      });
      request.on('end', () => {
        resolve(data);
      });
      request.on('error', (error) => {
        reject(error);
      });
    });
  }
}

class MessageTransport implements ITransport {
  #handlers: ((message: string) => void)[] = [];
  #sendBidiMessage: ((message: string) => Promise<void>) | null = null;

  setOnMessage(handler: Parameters<ITransport['setOnMessage']>[0]) {
    this.#handlers.push(handler);
  }

  sendMessage(message: string) {
    if (!this.#sendBidiMessage) {
      throw new Error('BiDi connection is not initialized yet');
    }

    return this.#sendBidiMessage(message);
  }

  close() {
    // Intentionally empty.
  }

  initialize(sendBidiMessage: (message: string) => Promise<void>) {
    this.#sendBidiMessage = sendBidiMessage;
  }

  onMessage(messageStr: string) {
    for (const handler of this.#handlers) handler(messageStr);
  }
}
