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
import type Protocol from 'devtools-protocol';

import type {ICdpClient} from '../../../cdp/cdpClient.js';
import type {ICdpConnection} from '../../../cdp/cdpConnection.js';
import {
  BrowsingContext,
  Input,
  InvalidArgumentException,
  NoSuchScriptException,
  Script,
  type Cdp,
  type EmptyResult,
  type Network,
} from '../../../protocol/protocol.js';
import {LogType, type LoggerFn} from '../../../utils/log.js';
import type {IEventManager} from '../events/EventManager.js';
import {ActionDispatcher} from '../input/ActionDispatcher.js';
import type {ActionOption} from '../input/ActionOption.js';
import {SourceType} from '../input/InputSource.js';
import type {InputState} from '../input/InputState.js';
import {InputStateManager} from '../input/InputStateManager.js';
import type {Realm} from '../script/realm.js';
import type {RealmStorage} from '../script/realmStorage.js';

import {PreloadScriptStorage} from './PreloadScriptStorage.js';
import {BidiPreloadScript} from './bidiPreloadScript';
import {BrowsingContextImpl} from './browsingContextImpl.js';
import type {BrowsingContextStorage} from './browsingContextStorage.js';
import {CdpTarget} from './cdpTarget.js';

export class BrowsingContextProcessor {
  readonly #browsingContextStorage: BrowsingContextStorage;
  readonly #cdpConnection: ICdpConnection;
  readonly #eventManager: IEventManager;
  readonly #logger?: LoggerFn;
  readonly #realmStorage: RealmStorage;
  readonly #selfTargetId: string;
  readonly #preloadScriptStorage = new PreloadScriptStorage();
  readonly #inputStateManager = new InputStateManager();

  constructor(
    cdpConnection: ICdpConnection,
    selfTargetId: string,
    eventManager: IEventManager,
    browsingContextStorage: BrowsingContextStorage,
    realmStorage: RealmStorage,
    logger?: LoggerFn
  ) {
    this.#cdpConnection = cdpConnection;
    this.#selfTargetId = selfTargetId;
    this.#eventManager = eventManager;
    this.#browsingContextStorage = browsingContextStorage;
    this.#realmStorage = realmStorage;

    this.#logger = logger;

    this.#setEventListeners(this.#cdpConnection.browserClient());
  }

  /**
   * This method is called for each CDP session, since this class is responsible
   * for creating and destroying all targets and browsing contexts.
   */
  #setEventListeners(cdpClient: ICdpClient) {
    cdpClient.on('Target.attachedToTarget', (params) => {
      this.#handleAttachedToTargetEvent(params, cdpClient);
    });
    cdpClient.on('Target.detachedFromTarget', (params) => {
      this.#handleDetachedFromTargetEvent(params);
    });
    cdpClient.on('Target.targetInfoChanged', (params) => {
      this.#handleTargetInfoChangedEvent(params);
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
    this.#browsingContextStorage.findContext(params.frameId)?.delete();
  }

  #handleAttachedToTargetEvent(
    params: Protocol.Target.AttachedToTargetEvent,
    parentSessionCdpClient: ICdpClient
  ) {
    const {sessionId, targetInfo} = params;

    const targetCdpClient = this.#cdpConnection.getCdpClient(sessionId);

    if (!this.#isValidTarget(targetInfo)) {
      // DevTools or some other not supported by BiDi target. Just release
      // debugger  and ignore them.
      targetCdpClient
        .sendCommand('Runtime.runIfWaitingForDebugger')
        .then(() =>
          parentSessionCdpClient.sendCommand('Target.detachFromTarget', params)
        )
        .catch((error) => this.#logger?.(LogType.system, error));
      return;
    }

    this.#logger?.(
      LogType.browsingContexts,
      'AttachedToTarget event received:',
      JSON.stringify(params, null, 2)
    );

    this.#setEventListeners(targetCdpClient);

    const maybeContext = this.#browsingContextStorage.findContext(
      targetInfo.targetId
    );

    const cdpTarget = CdpTarget.create(
      targetInfo.targetId,
      targetCdpClient,
      sessionId,
      this.#realmStorage,
      this.#eventManager,
      this.#preloadScriptStorage
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
        this.#eventManager,
        this.#browsingContextStorage,
        this.#logger
      );
    }
  }

  #handleDetachedFromTargetEvent(
    params: Protocol.Target.DetachedFromTargetEvent
  ) {
    // XXX: params.targetId is deprecated. Update this class to track using
    // params.sessionId instead.
    // https://github.com/GoogleChromeLabs/chromium-bidi/issues/60
    const contextId = params.targetId!;
    this.#browsingContextStorage.findContext(contextId)?.delete();

    this.#preloadScriptStorage
      .findPreloadScripts({targetId: contextId})
      .map((preloadScript) => preloadScript.cdpTargetIsGone(contextId));
  }

  #handleTargetInfoChangedEvent(
    params: Protocol.Target.TargetInfoChangedEvent
  ) {
    const contextId = params.targetInfo.targetId;
    this.#browsingContextStorage
      .findContext(contextId)
      ?.onTargetInfoChanged(params);
  }

  async #getRealm(target: Script.Target): Promise<Realm> {
    if ('realm' in target) {
      return this.#realmStorage.getRealm({
        realmId: target.realm,
      });
    }
    const context = this.#browsingContextStorage.getContext(target.context);
    return context.getOrCreateSandbox(target.sandbox);
  }

  process_browsingContext_getTree(
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

  async process_browsingContext_create(
    params: BrowsingContext.CreateParameters
  ): Promise<BrowsingContext.CreateResult> {
    const browserCdpClient = this.#cdpConnection.browserClient();

    let referenceContext: BrowsingContextImpl | undefined;
    if (params.referenceContext !== undefined) {
      referenceContext = this.#browsingContextStorage.getContext(
        params.referenceContext
      );
      if (!referenceContext.isTopLevelContext()) {
        throw new InvalidArgumentException(
          `referenceContext should be a top-level context`
        );
      }
    }

    let result: Protocol.Target.CreateTargetResponse;

    switch (params.type) {
      case BrowsingContext.CreateType.Tab:
        result = await browserCdpClient.sendCommand('Target.createTarget', {
          url: 'about:blank',
          newWindow: false,
        });
        break;
      case BrowsingContext.CreateType.Window:
        result = await browserCdpClient.sendCommand('Target.createTarget', {
          url: 'about:blank',
          newWindow: true,
        });
        break;
    }

    // Wait for the new tab to be loaded to avoid race conditions in the
    // `browsingContext` events, when the `browsingContext.domContentLoaded` and
    // `browsingContext.load` events from the initial `about:blank` navigation
    // are emitted after the next navigation is started.
    // Details: https://github.com/web-platform-tests/wpt/issues/35846
    const contextId = result.targetId;
    const context = this.#browsingContextStorage.getContext(contextId);
    await context.awaitLoaded();

    return {context: context.id};
  }

  process_browsingContext_navigate(
    params: BrowsingContext.NavigateParameters
  ): Promise<BrowsingContext.NavigateResult> {
    const context = this.#browsingContextStorage.getContext(params.context);

    return context.navigate(
      params.url,
      params.wait ?? BrowsingContext.ReadinessState.None
    );
  }

  process_browsingContext_reload(
    params: BrowsingContext.ReloadParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);

    return context.reload(
      params.ignoreCache ?? false,
      params.wait ?? BrowsingContext.ReadinessState.None
    );
  }

  async process_browsingContext_captureScreenshot(
    params: BrowsingContext.CaptureScreenshotParameters
  ): Promise<BrowsingContext.CaptureScreenshotResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    return context.captureScreenshot();
  }

  async process_browsingContext_print(
    params: BrowsingContext.PrintParameters
  ): Promise<BrowsingContext.PrintResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    return context.print(params);
  }

  async process_script_addPreloadScript(
    params: Script.AddPreloadScriptParameters
  ): Promise<Script.AddPreloadScriptResult> {
    const preloadScript = new BidiPreloadScript(params);
    this.#preloadScriptStorage.addPreloadScript(preloadScript);

    const cdpTargets = new Set<CdpTarget>(
      this.#browsingContextStorage
        .getTopLevelContexts()
        .map((context) => context.cdpTarget)
    );

    await preloadScript.initInTargets(cdpTargets);

    return {
      script: preloadScript.id,
    };
  }

  async process_script_removePreloadScript(
    params: Script.RemovePreloadScriptParameters
  ): Promise<EmptyResult> {
    const bidiId = params.script;

    const scripts = this.#preloadScriptStorage.findPreloadScripts({
      id: bidiId,
    });

    if (scripts.length === 0) {
      throw new NoSuchScriptException(
        `No preload script with BiDi ID '${bidiId}'`
      );
    }

    await Promise.all(scripts.map((script) => script.remove()));

    this.#preloadScriptStorage.removeBiDiPreloadScripts({
      id: bidiId,
    });

    return {};
  }

  async process_script_evaluate(
    params: Script.EvaluateParameters
  ): Promise<Script.EvaluateResult> {
    const realm = await this.#getRealm(params.target);
    return realm.scriptEvaluate(
      params.expression,
      params.awaitPromise,
      params.resultOwnership ?? Script.ResultOwnership.None,
      params.serializationOptions ?? {}
    );
  }

  process_script_getRealms(
    params: Script.GetRealmsParameters
  ): Script.GetRealmsResult {
    if (params.context !== undefined) {
      // Make sure the context is known.
      this.#browsingContextStorage.getContext(params.context);
    }
    const realms = this.#realmStorage
      .findRealms({
        browsingContextId: params.context,
        type: params.type,
      })
      .map((realm: Realm) => realm.toBiDi());
    return {realms};
  }

  async process_script_callFunction(
    params: Script.CallFunctionParameters
  ): Promise<Script.EvaluateResult> {
    const realm = await this.#getRealm(params.target);
    return realm.callFunction(
      params.functionDeclaration,
      params.this ?? {
        type: 'undefined',
      }, // `this` is `undefined` by default.
      params.arguments ?? [], // `arguments` is `[]` by default.
      params.awaitPromise,
      params.resultOwnership ?? Script.ResultOwnership.None,
      params.serializationOptions ?? {}
    );
  }

  async process_script_disown(
    params: Script.DisownParameters
  ): Promise<EmptyResult> {
    const realm = await this.#getRealm(params.target);
    await Promise.all(params.handles.map(async (h) => realm.disown(h)));
    return {};
  }

  async process_input_performActions(
    params: Input.PerformActionsParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    const inputState = this.#inputStateManager.get(context.top);
    const actionsByTick = this.#getActionsByTick(params, inputState);
    const dispatcher = new ActionDispatcher(
      inputState,
      context,
      await ActionDispatcher.isMacOS(context).catch(() => false)
    );
    await dispatcher.dispatchActions(actionsByTick);
    return {};
  }

  #getActionsByTick(
    params: Input.PerformActionsParameters,
    inputState: InputState
  ): ActionOption[][] {
    const actionsByTick: ActionOption[][] = [];
    for (const action of params.actions) {
      switch (action.type) {
        case SourceType.Pointer: {
          action.parameters ??= {pointerType: Input.PointerType.Mouse};
          action.parameters.pointerType ??= Input.PointerType.Mouse;

          const source = inputState.getOrCreate(
            action.id,
            SourceType.Pointer,
            action.parameters.pointerType
          );
          if (source.subtype !== action.parameters.pointerType) {
            throw new InvalidArgumentException(
              `Expected input source ${action.id} to be ${source.subtype}; got ${action.parameters.pointerType}.`
            );
          }
          break;
        }
        default:
          inputState.getOrCreate(action.id, action.type as SourceType);
      }
      const actions = action.actions.map((item) => ({
        id: action.id,
        action: item,
      }));
      for (let i = 0; i < actions.length; i++) {
        if (actionsByTick.length === i) {
          actionsByTick.push([]);
        }
        actionsByTick[i]!.push(actions[i]!);
      }
    }
    return actionsByTick;
  }

  async process_input_releaseActions(
    params: Input.ReleaseActionsParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    const topContext = context.top;
    const inputState = this.#inputStateManager.get(topContext);
    const dispatcher = new ActionDispatcher(
      inputState,
      context,
      await ActionDispatcher.isMacOS(context).catch(() => false)
    );
    await dispatcher.dispatchTickActions(inputState.cancelList.reverse());
    this.#inputStateManager.delete(topContext);
    return {};
  }

  async process_browsingContext_setViewport(
    params: BrowsingContext.SetViewportParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    if (!context.isTopLevelContext()) {
      throw new InvalidArgumentException(
        'Emulating viewport is only supported on the top-level context'
      );
    }
    await context.setViewport(params.viewport);
    return {};
  }

  async process_browsingContext_handleUserPrompt(
    params: BrowsingContext.HandleUserPromptParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(params.context);
    await context.handleUserPrompt(params);
    return {};
  }

  async process_browsingContext_close(
    commandParams: BrowsingContext.CloseParameters
  ): Promise<EmptyResult> {
    const context = this.#browsingContextStorage.getContext(
      commandParams.context
    );

    if (!context.isTopLevelContext()) {
      throw new InvalidArgumentException(
        `Non top-level browsing context ${context.id} cannot be closed.`
      );
    }

    const browserCdpClient = this.#cdpConnection.browserClient();

    try {
      await context.close();

      const detachedFromTargetPromise = new Promise<void>((resolve) => {
        const onContextDestroyed = (
          event: Protocol.Target.DetachedFromTargetEvent
        ) => {
          if (event.targetId === commandParams.context) {
            browserCdpClient.off(
              'Target.detachedFromTarget',
              onContextDestroyed
            );
            resolve();
          }
        };
        browserCdpClient.on('Target.detachedFromTarget', onContextDestroyed);
      });
      // Sometimes CDP command finishes before `detachedFromTarget` event,
      // sometimes after. Wait for the CDP command to be finished, and then wait
      // for `detachedFromTarget` if it hasn't emitted.
      await detachedFromTargetPromise;
    } catch (error: any) {
      // Swallow error that arise from the page being destroyed
      // Example is navigating to faulty SSL certificate
      if (
        !(
          error.code === -32000 &&
          error.message === 'Not attached to an active page'
        )
      ) {
        throw error;
      }
    }

    return {};
  }

  #isValidTarget(target: Protocol.Target.TargetInfo) {
    if (target.targetId === this.#selfTargetId) {
      return false;
    }
    return ['page', 'iframe'].includes(target.type);
  }

  process_cdp_getSession(
    params: Cdp.GetSessionParameters
  ): Cdp.GetSessionResult {
    const context = params.context;
    const sessionId =
      this.#browsingContextStorage.getContext(context).cdpTarget.cdpSessionId;
    if (sessionId === undefined) {
      return {};
    }
    return {session: sessionId};
  }

  async process_cdp_sendCommand(
    params: Cdp.SendCommandParameters
  ): Promise<Cdp.SendCommandResult> {
    const client = params.session
      ? this.#cdpConnection.getCdpClient(params.session)
      : this.#cdpConnection.browserClient();
    const result = await client.sendCommand(params.method, params.params);
    return {
      result,
      session: params.session,
    };
  }

  process_network_addIntercept(
    _params: Network.AddInterceptParameters
  ): Network.AddInterceptResult {
    // TODO: Implement.
    return {
      intercept: '',
    };
  }

  process_network_continueRequest(
    _params: Network.ContinueRequestParameters
  ): EmptyResult {
    // TODO: Implement.
    return {};
  }

  process_network_continueResponse(
    _params: Network.ContinueResponseParameters
  ): EmptyResult {
    // TODO: Implement.
    return {};
  }

  process_network_continueWithAuth(
    _params: Network.ContinueWithAuthParameters
  ): EmptyResult {
    // TODO: Implement.
    return {};
  }

  process_network_failRequest(
    _params: Network.FailRequestParameters
  ): EmptyResult {
    // TODO: Implement.
    return {};
  }

  process_network_provideResponse(
    _params: Network.ProvideResponseParameters
  ): EmptyResult {
    // TODO: Implement.
    return {};
  }

  process_network_removeIntercept(
    _params: Network.RemoveInterceptParameters
  ): EmptyResult {
    // TODO: Implement.
    return {};
  }
}
