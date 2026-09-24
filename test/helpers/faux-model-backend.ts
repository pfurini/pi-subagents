/**
 * faux-model-backend.ts — the model/auth plumbing a faux-provider session needs,
 * in one place.
 *
 * `registerFauxProvider` scripts the *responses*, but a session still has to get
 * past model lookup and auth before it streams anything.
 * `createAgentSession` takes `modelRuntime`; the turn itself streams through
 * `modelRuntime.streamSimple`. `modelRegistry` stands in for
 * `ExtensionContext.modelRegistry` in code under test: model lookup, auth
 * checks, and `streamSimple` for the mention clone's one request.
 *
 * Structural fakes (not real instances) keep the suites hermetic: no
 * auth.json, no network, no local login state.
 */
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "./pi-ai.js";

/** Both option shapes for `createAgentSession`, for the given faux model. */
export function fauxModelBackend(model: Model<string>): {
  modelRegistry: any;
  modelRuntime: any;
} {
  return {
    modelRegistry: {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      // createAgentSession's injected streamFn checks `auth.ok` and throws
      // Error(auth.error) otherwise — so the `ok: true` flag is mandatory, not
      // cosmetic. Without it the turn dies before streaming (empty error message).
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
      // ctx.modelRegistry.streamSimple (pi >= 0.86): the mention clone's one request.
      stream: streamSimple,
      streamSimple,
    },
    modelRuntime: {
      getModel: () => model,
      getModels: () => [model],
      getProvider: () => undefined,
      getProviders: () => [],
      getAvailable: async () => [model],
      getAvailableSnapshot: () => [model],
      getError: () => undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ ok: true }),
      isUsingOAuth: () => false,
      isUsingSubscription: () => false,
      // Shape mirrors ModelRuntime.getAuth: the session reads `auth.apiKey` /
      // `auth.headers` and throws "No API key found" when both are absent.
      getAuth: async () => ({ auth: { apiKey: "faux", headers: {} } }),
      getProviderAuthStatus: () => "configured",
      getCompatibilityRequestConfig: () => ({}),
      getRegisteredProviderIds: () => [],
      getRegisteredProviderConfig: () => undefined,
      getRegisteredNativeProvider: () => undefined,
      registerProvider: () => {},
      registerNativeProvider: () => {},
      unregisterProvider: () => {},
      refresh: async () => ({}),
      // The faux provider registers itself in pi-ai's global api-provider
      // registry, so compat's dispatcher reaches it by `model.api`.
      stream: streamSimple,
      streamSimple,
    },
  };
}
