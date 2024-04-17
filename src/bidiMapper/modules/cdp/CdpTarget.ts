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
  #fetchDomainStages = {
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
        this.toggleNetworkIfNeeded(),
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

  async toggleFetchIfNeeded() {
    const stages = this.#networkStorage.getInterceptionStages(this.topLevelId);

    if (
      // Only toggle interception when Network is enabled
      !this.#networkDomainEnabled ||
      (this.#fetchDomainStages.request === stages.request &&
        this.#fetchDomainStages.response === stages.response &&
        this.#fetchDomainStages.auth === stages.auth)
    ) {
      return;
    }
    const patterns: Protocol.Fetch.EnableRequest['patterns'] = [];

    this.#fetchDomainStages = stages;
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
    if (patterns.length) {
      await this.#cdpClient.sendCommand('Fetch.enable', {
        patterns,
        handleAuthRequests: stages.auth,
      });
    } else {
      const blockedRequest = this.#networkStorage
        .getRequestsByTarget(this)
        .filter((request) => request.interceptPhase);
      void Promise.allSettled(
        blockedRequest.map((request) => request.waitNextPhase)
      )
        .then(async () => {
          return await this.#cdpClient.sendCommand('Fetch.disable');
        })
        .catch((error) => {
          this.#logger?.(LogType.bidi, 'Disable failed', error);
        });
    }
  }

  /**
   * Toggles both Network and Fetch domains.
   */
  async toggleNetworkIfNeeded(): Promise<void> {
    const enabled = this.isSubscribedTo(BiDiModule.Network);
    if (enabled === this.#networkDomainEnabled) {
      return;
    }

    this.#networkDomainEnabled = enabled;
    try {
      await Promise.all([
        this.#cdpClient.sendCommand(
          enabled ? 'Network.enable' : 'Network.disable'
        ),
        this.toggleFetchIfNeeded(),
      ]);
    } catch (err) {
      this.#networkDomainEnabled = !enabled;
    }
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
