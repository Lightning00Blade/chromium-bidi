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
import type {Protocol} from 'devtools-protocol';

import type {CdpClient} from '../../../cdp/CdpClient.js';
import type {CdpConnection} from '../../../cdp/CdpConnection.js';
import {
  BrowsingContext,
  InvalidArgumentException,
  type EmptyResult,
  NoSuchUserContextException,
  type Browser,
  NoSuchAlertException,
} from '../../../protocol/protocol.js';
import {CdpErrorConstants} from '../../../utils/CdpErrorConstants.js';
import {LogType, type LoggerFn} from '../../../utils/log.js';
import type {BluetoothProcessor} from '../bluetooth/BluetoothProcessor.js';
import type {NetworkStorage} from '../network/NetworkStorage.js';
import type {PreloadScriptStorage} from '../script/PreloadScriptStorage.js';
import type {Realm} from '../script/Realm.js';
import type {RealmStorage} from '../script/RealmStorage.js';
import {WorkerRealm, type WorkerRealmType} from '../script/WorkerRealm.js';
import type {EventManager} from '../session/EventManager.js';

import {BrowsingContextImpl, serializeOrigin} from './BrowsingContextImpl.js';
import type {BrowsingContextStorage} from './BrowsingContextStorage.js';
import {CdpTarget} from './CdpTarget.js';

const cdpToBidiTargetTypes = {
  service_worker: 'service-worker',
  shared_worker: 'shared-worker',
  worker: 'dedicated-worker',
} as const;

export class BrowsingContextProcessor {
  readonly #browserCdpClient: CdpClient;
  readonly #cdpConnection: CdpConnection;
  readonly #selfTargetId: string;
  readonly #eventManager: EventManager;

  readonly #bluetoothProcessor: BluetoothProcessor;

  readonly #browsingContextStorage: BrowsingContextStorage;
  readonly #networkStorage: NetworkStorage;
  readonly #acceptInsecureCerts: boolean;
  readonly #preloadScriptStorage: PreloadScriptStorage;
  readonly #realmStorage: RealmStorage;

  readonly #defaultUserContextId: Browser.UserContext;
  readonly #logger?: LoggerFn;

  constructor(
    cdpConnection: CdpConnection,
    browserCdpClient: CdpClient,
    selfTargetId: string,
    eventManager: EventManager,
    browsingContextStorage: BrowsingContextStorage,
    realmStorage: RealmStorage,
    bluetoothProcessor: BluetoothProcessor,
    networkStorage: NetworkStorage,
    preloadScriptStorage: PreloadScriptStorage,
    acceptInsecureCerts: boolean,
    defaultUserContextId: Browser.UserContext,
    logger?: LoggerFn
  ) {
    this.#acceptInsecureCerts = acceptInsecureCerts;
    this.#bluetoothProcessor = bluetoothProcessor;
    this.#cdpConnection = cdpConnection;
    this.#browserCdpClient = browserCdpClient;
    this.#selfTargetId = selfTargetId;
    this.#eventManager = eventManager;
    this.#browsingContextStorage = browsingContextStorage;
    this.#preloadScriptStorage = preloadScriptStorage;
    this.#networkStorage = networkStorage;
    this.#realmStorage = realmStorage;
    this.#defaultUserContextId = defaultUserContextId;
    this.#logger = logger;

    this.#setEventListeners(browserCdpClient);
  }

  getTree(
    params: BrowsingContext.GetTreeParameters
  ): BrowsingContext.GetTreeResult {
    const resultContexts =
      params.root === undefined
        ? this.#browsingContextStorage.getTopLevelContexts()
        : [this.#browsingContextStorage.getContext(params.root)];

    return {
      contexts: resultContexts.map((c) =>
        c.serializeToBidiValue(params.maxDepth ?? Number.MAX_VALUE)
      ),
    };
  }

  async create(
    params: BrowsingContext.CreateParameters
  ): Promise<BrowsingContext.CreateResult> {
    let referenceContext: BrowsingContextImpl | undefined;
    let userContext = 'default';
    if (params.referenceContext !== undefined) {
      referenceContext = this.#browsingContextStorage.getContext(
        params.referenceContext
      );
      if (!referenceContext.isTopLevelContext()) {
        throw new InvalidArgumentException(
          `referenceContext should be a top-level context`
        );
      }
      userContext = referenceContext.userContext;
    }

    if (params.userContext !== undefined) {
      userContext = params.userContext;
    }

    let newWindow = false;
    switch (params.type) {
      case BrowsingContext.CreateType.Tab:
        newWindow = false;
        break;
      case BrowsingContext.CreateType.Window:
        newWindow = true;
        break;
    }

    if (userContext !== 'default') {
      const existingContexts = this.#browsingContextStorage
        .getAllContexts()
        .filter((context) => context.userContext === userContext);

      if (!existingContexts.length) {
        // If there are no contexts in the given user context, we need to set
        // newWindow to true as newWindow=false will be rejected.
        newWindow = true;
      }
    }

    let result: Protocol.Target.CreateTargetResponse;

    try {
      result = await this.#browserCdpClient.sendCommand('Target.createTarget', {
        url: 'about:blank',
        newWindow,
        browserContextId: userContext === 'default' ? undefined : userContext,
      });
    } catch (err) {
      if (
        // See https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/devtools/protocol/target_handler.cc;l=90;drc=e80392ac11e48a691f4309964cab83a3a59e01c8
        (err as Error).message.startsWith(
          'Failed to find browser context with id'
        ) ||
        // See https://source.chromium.org/chromium/chromium/src/+/main:headless/lib/browser/protocol/target_handler.cc;l=49;drc=e80392ac11e48a691f4309964cab83a3a59e01c8
        (err as Error).message === 'browserContextId'
      ) {
        throw new NoSuchUserContextException(
          `The context ${userContext} was not found`
        );
      }
      throw err;
    }

    // Wait for the new tab to be loaded to avoid race conditions in the
    // `browsingContext` events, when the `browsingContext.domContentLoaded` and
    // `browsingContext.load` events from the initial `about:blank` navigation
    // are emitted after the next navigation is started.
    // Details: https://github.com/web-platform-tests/wpt/issues/35846
    const contextId = result.targetId;
    const context = this.#browsingContextStorage.getContext(contextId);
    await context.lifecycleLoaded();

    return {context: context.id};
  }

  navigate(
    params: BrowsingContext.NavigateParameters
  ): Promise<BrowsingContext.NavigateResult> {
    const context = this.#browsingContextStorage.getContext(params.context);

    return context.navigate(
      params.url,
      params.wait ?? BrowsingContext.ReadinessState.None
    );
  }

  reload(params: BrowsingContext.ReloadParameters): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);

    return context.reload(
      params.ignoreCache ?? false,
      params.wait ?? BrowsingContext.ReadinessState.None
    );
  }

  async activate(
    params: BrowsingContext.ActivateParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    if (!context.isTopLevelContext()) {
      throw new InvalidArgumentException(
        'Activation is only supported on the top-level context'
      );
    }
    await context.activate();
    return {};
  }

  async captureScreenshot(
    params: BrowsingContext.CaptureScreenshotParameters
  ): Promise<BrowsingContext.CaptureScreenshotResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    return await context.captureScreenshot(params);
  }

  async print(
    params: BrowsingContext.PrintParameters
  ): Promise<BrowsingContext.PrintResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    return await context.print(params);
  }

  async setViewport(
    params: BrowsingContext.SetViewportParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    if (!context.isTopLevelContext()) {
      throw new InvalidArgumentException(
        'Emulating viewport is only supported on the top-level context'
      );
    }
    await context.setViewport(params.viewport, params.devicePixelRatio);
    return {};
  }

  async traverseHistory(
    params: BrowsingContext.TraverseHistoryParameters
  ): Promise<BrowsingContext.TraverseHistoryResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    if (!context) {
      throw new InvalidArgumentException(
        `No browsing context with id ${params.context}`
      );
    }
    await context.traverseHistory(params.delta);
    return {};
  }

  async handleUserPrompt(
    params: BrowsingContext.HandleUserPromptParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    try {
      await context.handleUserPrompt(params);
    } catch (error: any) {
      // Heuristically determine the error
      // https://source.chromium.org/chromium/chromium/src/+/main:content/browser/devtools/protocol/page_handler.cc;l=1085?q=%22No%20dialog%20is%20showing%22&ss=chromium
      if (error.message?.includes('No dialog is showing')) {
        throw new NoSuchAlertException('No dialog is showing');
      }
      throw error;
    }
    return {};
  }

  async close(params: BrowsingContext.CloseParameters): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);

    if (!context.isTopLevelContext()) {
      throw new InvalidArgumentException(
        `Non top-level browsing context ${context.id} cannot be closed.`
      );
    }

    try {
      const detachedFromTargetPromise = new Promise<void>((resolve) => {
        const onContextDestroyed = (
          event: Protocol.Target.DetachedFromTargetEvent
        ) => {
          if (event.targetId === params.context) {
            this.#browserCdpClient.off(
              'Target.detachedFromTarget',
              onContextDestroyed
            );
            resolve();
          }
        };
        this.#browserCdpClient.on(
          'Target.detachedFromTarget',
          onContextDestroyed
        );
      });

      if (params.promptUnload) {
        await context.close();
      } else {
        await this.#browserCdpClient.sendCommand('Target.closeTarget', {
          targetId: params.context,
        });
      }

      // Sometimes CDP command finishes before `detachedFromTarget` event,
      // sometimes after. Wait for the CDP command to be finished, and then wait
      // for `detachedFromTarget` if it hasn't emitted.
      await detachedFromTargetPromise;
    } catch (error: any) {
      // Swallow error that arise from the page being destroyed
      // Example is navigating to faulty SSL certificate
      if (
        !(
          error.code === CdpErrorConstants.GENERIC_ERROR &&
          error.message === 'Not attached to an active page'
        )
      ) {
        throw error;
      }
    }

    return {};
  }

  async locateNodes(
    params: BrowsingContext.LocateNodesParameters
  ): Promise<BrowsingContext.LocateNodesResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    return await context.locateNodes(params);
  }

  /**
   * This method is called for each CDP session, since this class is responsible
   * for creating and destroying all targets and browsing contexts.
   */
  #setEventListeners(cdpClient: CdpClient) {
    cdpClient.on('Target.attachedToTarget', (params) => {
      this.#handleAttachedToTargetEvent(params, cdpClient);
    });
    cdpClient.on('Target.detachedFromTarget', (params) => {
      this.#handleDetachedFromTargetEvent(params);
    });
    cdpClient.on('Target.targetInfoChanged', (params) => {
      this.#handleTargetInfoChangedEvent(params);
    });
    cdpClient.on('Inspector.targetCrashed', () => {
      this.#handleTargetCrashedEvent(cdpClient);
    });

    cdpClient.on(
      'Page.frameAttached',
      (params: Protocol.Page.FrameAttachedEvent) => {
        this.#handleFrameAttachedEvent(params);
      }
    );
    cdpClient.on(
      'Page.frameDetached',
      (params: Protocol.Page.FrameDetachedEvent) => {
        this.#handleFrameDetachedEvent(params);
      }
    );
  }

  #handleFrameAttachedEvent(params: Protocol.Page.FrameAttachedEvent) {
    const parentBrowsingContext = this.#browsingContextStorage.findContext(
      params.parentFrameId
    );
    if (parentBrowsingContext !== undefined) {
      BrowsingContextImpl.create(
        parentBrowsingContext.cdpTarget,
        this.#realmStorage,
        params.frameId,
        params.parentFrameId,
        parentBrowsingContext.userContext,
        this.#eventManager,
        this.#browsingContextStorage,
        this.#logger
      );
    }
  }

  #handleFrameDetachedEvent(params: Protocol.Page.FrameDetachedEvent) {
    // In case of OOPiF no need in deleting BrowsingContext.
    if (params.reason === 'swap') {
      return;
    }
    this.#browsingContextStorage.findContext(params.frameId)?.dispose();
  }

  #handleAttachedToTargetEvent(
    params: Protocol.Target.AttachedToTargetEvent,
    parentSessionCdpClient: CdpClient
  ) {
    const {sessionId, targetInfo} = params;
    const targetCdpClient = this.#cdpConnection.getCdpClient(sessionId);

    this.#logger?.(
      LogType.debugInfo,
      'AttachedToTarget event received:',
      params
    );

    switch (targetInfo.type) {
      case 'page':
      case 'iframe': {
        if (targetInfo.targetId === this.#selfTargetId) {
          break;
        }

        const cdpTarget = this.#createCdpTarget(targetCdpClient, targetInfo);
        const maybeContext = this.#browsingContextStorage.findContext(
          targetInfo.targetId
        );
        if (maybeContext) {
          // OOPiF.
          maybeContext.updateCdpTarget(cdpTarget);
        } else {
          // New context.
          BrowsingContextImpl.create(
            cdpTarget,
            this.#realmStorage,
            targetInfo.targetId,
            null,
            targetInfo.browserContextId &&
              targetInfo.browserContextId !== this.#defaultUserContextId
              ? targetInfo.browserContextId
              : 'default',
            this.#eventManager,
            this.#browsingContextStorage,
            this.#logger
          );
        }
        return;
      }
      case 'service_worker':
      case 'worker': {
        const realm = this.#realmStorage.findRealm({
          cdpSessionId: parentSessionCdpClient.sessionId,
        });
        // If there is no browsing context, this worker is already terminated.
        if (!realm) {
          break;
        }

        const cdpTarget = this.#createCdpTarget(targetCdpClient, targetInfo);
        this.#handleWorkerTarget(
          cdpToBidiTargetTypes[targetInfo.type],
          cdpTarget,
          realm
        );
        return;
      }
      // In CDP, we only emit shared workers on the browser and not the set of
      // frames that use the shared worker. If we change this in the future to
      // behave like service workers (emits on both browser and frame targets),
      // we can remove this block and merge service workers with the above one.
      case 'shared_worker': {
        const cdpTarget = this.#createCdpTarget(targetCdpClient, targetInfo);
        this.#handleWorkerTarget(
          cdpToBidiTargetTypes[targetInfo.type],
          cdpTarget
        );
        return;
      }
    }

    // DevTools or some other not supported by BiDi target. Just release
    // debugger and ignore them.
    targetCdpClient
      .sendCommand('Runtime.runIfWaitingForDebugger')
      .then(() =>
        parentSessionCdpClient.sendCommand('Target.detachFromTarget', params)
      )
      .catch((error) => this.#logger?.(LogType.debugError, error));
  }

  #createCdpTarget(
    targetCdpClient: CdpClient,
    targetInfo: Protocol.Target.TargetInfo
  ) {
    this.#setEventListeners(targetCdpClient);

    const target = CdpTarget.create(
      targetInfo.targetId,
      targetCdpClient,
      this.#browserCdpClient,
      this.#realmStorage,
      this.#eventManager,
      this.#preloadScriptStorage,
      this.#networkStorage,
      this.#acceptInsecureCerts,
      this.#logger
    );

    this.#networkStorage.onCdpTargetCreated(target);
    this.#bluetoothProcessor.onCdpTargetCreated(target);

    return target;
  }

  #workers = new Map<string, Realm>();
  #handleWorkerTarget(
    realmType: WorkerRealmType,
    cdpTarget: CdpTarget,
    ownerRealm?: Realm
  ) {
    cdpTarget.cdpClient.on('Runtime.executionContextCreated', (params) => {
      const {uniqueId, id, origin} = params.context;
      const workerRealm = new WorkerRealm(
        cdpTarget.cdpClient,
        this.#eventManager,
        id,
        this.#logger,
        serializeOrigin(origin),
        ownerRealm ? [ownerRealm] : [],
        uniqueId,
        this.#realmStorage,
        realmType
      );
      this.#workers.set(cdpTarget.cdpSessionId, workerRealm);
    });
  }

  #handleDetachedFromTargetEvent(
    params: Protocol.Target.DetachedFromTargetEvent
  ) {
    const context = this.#browsingContextStorage.findContextBySession(
      params.sessionId
    );
    if (context) {
      context.dispose();
      this.#preloadScriptStorage
        .find({targetId: context.id})
        .map((preloadScript) => preloadScript.dispose(context.id));
      return;
    }

    const worker = this.#workers.get(params.sessionId);
    if (worker) {
      this.#realmStorage.deleteRealms({
        cdpSessionId: worker.cdpClient.sessionId,
      });
    }
  }

  #handleTargetInfoChangedEvent(
    params: Protocol.Target.TargetInfoChangedEvent
  ) {
    const context = this.#browsingContextStorage.findContext(
      params.targetInfo.targetId
    );
    if (context) {
      context.onTargetInfoChanged(params);
    }
  }

  #handleTargetCrashedEvent(cdpClient: CdpClient) {
    // This is primarily used for service and shared workers. CDP tends to not
    // signal they closed gracefully and instead says they crashed to signal
    // they are closed.
    const realms = this.#realmStorage.findRealms({
      cdpSessionId: cdpClient.sessionId,
    });
    for (const realm of realms) {
      realm.dispose();
    }
  }
}
