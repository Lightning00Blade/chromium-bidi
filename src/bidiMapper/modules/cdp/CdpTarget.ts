/*
 * Copyright 2023 Google LLC.
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
 *
 */
import type {Protocol} from 'devtools-protocol';

import type {CdpClient} from '../../../cdp/CdpClient.js';
import {BiDiModule} from '../../../protocol/chromium-bidi.js';
import type {ChromiumBidi} from '../../../protocol/protocol.js';
import {Deferred} from '../../../utils/Deferred.js';
import {LogType, type LoggerFn} from '../../../utils/log.js';
import type {Result} from '../../../utils/result.js';
import type {BrowsingContextStorage} from '../context/BrowsingContextStorage.js';
import {LogManager} from '../log/LogManager.js';
import type {NetworkStorage} from '../network/NetworkStorage.js';
import type {ChannelProxy} from '../script/ChannelProxy.js';
import type {PreloadScriptStorage} from '../script/PreloadScriptStorage.js';
import type {RealmStorage} from '../script/RealmStorage.js';
import type {EventManager} from '../session/EventManager.js';

interface FetchStages {
  request: boolean;
  response: boolean;
  auth: boolean;
}
export class CdpTarget {
  readonly #id: Protocol.Target.TargetID;
  readonly #cdpClient: CdpClient;
  readonly #browserCdpClient: CdpClient;
  readonly #eventManager: EventManager;
  readonly #logger?: LoggerFn;

  readonly #preloadScriptStorage: PreloadScriptStorage;
  readonly #browsingContextStorage: BrowsingContextStorage;
  readonly #networkStorage: NetworkStorage;

  readonly #unblocked = new Deferred<Result<void>>();
  readonly #acceptInsecureCerts: boolean;

  #networkDomainEnabled = false;
  #fetchDomainStages: FetchStages = {
    request: false,
    response: false,
    auth: false,
  };

  static create(
    targetId: Protocol.Target.TargetID,
    cdpClient: CdpClient,
    browserCdpClient: CdpClient,
    realmStorage: RealmStorage,
    eventManager: EventManager,
    preloadScriptStorage: PreloadScriptStorage,
    browsingContextStorage: BrowsingContextStorage,
    networkStorage: NetworkStorage,
    acceptInsecureCerts: boolean,
    logger?: LoggerFn
  ): CdpTarget {
    const cdpTarget = new CdpTarget(
      targetId,
      cdpClient,
      browserCdpClient,
      eventManager,
      preloadScriptStorage,
      browsingContextStorage,
      networkStorage,
      acceptInsecureCerts,
      logger
    );

    LogManager.create(cdpTarget, realmStorage, eventManager, logger);

    cdpTarget.#setEventListeners();

    // No need to await.
    // Deferred will be resolved when the target is unblocked.
    void cdpTarget.#unblock();

    return cdpTarget;
  }

  constructor(
    targetId: Protocol.Target.TargetID,
    cdpClient: CdpClient,
    browserCdpClient: CdpClient,
    eventManager: EventManager,
    preloadScriptStorage: PreloadScriptStorage,
    browsingContextStorage: BrowsingContextStorage,
    networkStorage: NetworkStorage,
    acceptInsecureCerts: boolean,
    logger?: LoggerFn
  ) {
    this.#id = targetId;
    this.#cdpClient = cdpClient;
    this.#browserCdpClient = browserCdpClient;
    this.#eventManager = eventManager;
    this.#preloadScriptStorage = preloadScriptStorage;
    this.#networkStorage = networkStorage;
    this.#browsingContextStorage = browsingContextStorage;
    this.#acceptInsecureCerts = acceptInsecureCerts;
    this.#logger = logger;
  }

  /** Returns a deferred that resolves when the target is unblocked. */
  get unblocked(): Deferred<Result<void>> {
    return this.#unblocked;
  }

  get id(): Protocol.Target.TargetID {
    return this.#id;
  }

  get cdpClient(): CdpClient {
    return this.#cdpClient;
  }

  get browserCdpClient(): CdpClient {
    return this.#browserCdpClient;
  }

  /** Needed for CDP escape path. */
  get cdpSessionId(): Protocol.Target.SessionID {
    // SAFETY we got the client by it's id for creating
    return this.#cdpClient.sessionId!;
  }

  /**
   * Enables all the required CDP domains and unblocks the target.
   */
  async #unblock() {
    try {
      await Promise.all([
        this.#cdpClient.sendCommand('Runtime.enable'),
        this.#cdpClient.sendCommand('Page.enable'),
        this.#cdpClient.sendCommand('Page.setLifecycleEventsEnabled', {
          enabled: true,
        }),
        // Set ignore certificate errors for each target.
        this.#cdpClient.sendCommand('Security.setIgnoreCertificateErrors', {
          ignore: this.#acceptInsecureCerts,
        }),
        this.toggleNetwork(),
        this.#cdpClient.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        }),
        this.#initAndEvaluatePreloadScripts(),
        this.#cdpClient.sendCommand('Runtime.runIfWaitingForDebugger'),
      ]);
    } catch (error: any) {
      // The target might have been closed before the initialization finished.
      if (!this.#cdpClient.isCloseError(error)) {
        this.#unblocked.resolve({
          kind: 'error',
          error,
        });
        return;
      }
    }

    this.#unblocked.resolve({
      kind: 'success',
      value: undefined,
    });
  }

  #setEventListeners() {
    this.#cdpClient.on('*', (event, params) => {
      // We may encounter uses for EventEmitter other than CDP events,
      // which we want to skip.
      if (typeof event !== 'string') {
        return;
      }
      this.#eventManager.registerEvent(
        {
          type: 'event',
          method: `cdp.${event}`,
          params: {
            event,
            params,
            session: this.cdpSessionId,
          },
        },
        this.id
      );
    });
  }

  async #toggleNetwork(enable: boolean): Promise<void> {
    this.#networkDomainEnabled = enable;
    try {
      await this.#cdpClient.sendCommand(
        enable ? 'Network.enable' : 'Network.disable'
      );
    } catch (err) {
      this.#networkDomainEnabled = !enable;
    }
  }

  async #enableFetch(stages: FetchStages) {
    const patterns: Protocol.Fetch.EnableRequest['patterns'] = [];

    if (stages.request || stages.auth) {
      // CDP quirk we need request interception when we intercept auth
      patterns.push({
        urlPattern: '*',
        requestStage: 'Request',
      });
    }
    if (stages.response) {
      patterns.push({
        urlPattern: '*',
        requestStage: 'Response',
      });
    }
    if (
      // Only enable interception when Network is enabled
      this.#networkDomainEnabled &&
      patterns.length
    ) {
      const oldStages = this.#fetchDomainStages;
      this.#fetchDomainStages = stages;
      try {
        await this.#cdpClient.sendCommand('Fetch.enable', {
          patterns,
          handleAuthRequests: stages.auth,
        });
      } catch {
        this.#fetchDomainStages = oldStages;
      }
    }
  }

  async #disableFetch(network: boolean) {
    const blockedRequest = this.#networkStorage
      .getRequestsByTarget(this)
      .filter((request) => request.interceptPhase);

    if (blockedRequest.length === 0) {
      this.#fetchDomainStages = {
        request: false,
        response: false,
        auth: false,
      };
      return await this.#cdpClient.sendCommand('Fetch.disable');
    }

    void Promise.all(blockedRequest.map((request) => request.waitNextPhase))
      .then(async () => {
        return await this.toggleNetwork();
      })
      .catch((error) => {
        this.#logger?.(LogType.bidi, 'Disable failed', error);
      });

    return;
  }

  async toggleNetwork() {
    const stages = this.#networkStorage.getInterceptionStages(this.topLevelId);
    const fetchEnable = Object.values(stages).some((value) => value);
    const fetchChanged =
      this.#fetchDomainStages.request !== stages.request ||
      this.#fetchDomainStages.response !== stages.response ||
      this.#fetchDomainStages.auth !== stages.auth;
    const networkEnable = this.isSubscribedTo(BiDiModule.Network);
    const networkChanged = this.#networkDomainEnabled !== networkEnable;

    this.#logger?.(
      LogType.debugInfo,
      'Toggle Network',
      `Fetch (${fetchEnable}) ${fetchChanged}`,
      `Network (${networkEnable}) ${networkChanged}`
    );

    if (networkEnable && networkChanged) {
      await this.#toggleNetwork(true);
    }
    if (fetchEnable && fetchChanged) {
      await this.#enableFetch(stages);
    }
    if (!fetchEnable && fetchChanged) {
      await this.#disableFetch(!networkEnable && networkChanged);
    }

    if (!networkEnable && networkChanged && !fetchEnable && !fetchChanged) {
      await this.#toggleNetwork(false);
    }
  }

  /**
   * All the ProxyChannels from all the preload scripts of the given
   * BrowsingContext.
   */
  getChannels(): ChannelProxy[] {
    return this.#preloadScriptStorage
      .find()
      .flatMap((script) => script.channels);
  }

  /** Loads all top-level preload scripts. */
  async #initAndEvaluatePreloadScripts() {
    await Promise.all(
      this.#preloadScriptStorage
        .find({
          // Needed for OOPIF
          targetId: this.topLevelId,
          global: true,
        })
        .map((script) => {
          return script.initInTarget(this, true);
        })
    );
  }

  get topLevelId() {
    return (
      this.#browsingContextStorage.findTopLevelContextId(this.id) ?? this.id
    );
  }

  isSubscribedTo(moduleOrEvent: ChromiumBidi.EventNames): boolean {
    return this.#eventManager.subscriptionManager.isSubscribedTo(
      moduleOrEvent,
      this.topLevelId
    );
  }
}
