/**
 * pi-ai.ts — single import point for the faux-provider test helpers.
 *
 * `getModel`, `registerFauxProvider` and `streamSimple` exist only on the
 * `/compat` subpath since pi-ai 0.80. Upstream deletes `/compat` with its
 * coding-agent ModelManager migration; the replacement then is
 * `fauxProvider()` + `createModels()`.
 *
 * `registerFauxProvider` is wrapped. Since pi 0.86 a provider receives a
 * `TranscriptContext`: the system prompt and the tool declarations travel as
 * `role: "system"` messages, and `context.systemPrompt` / `context.tools` are
 * gone. Every scripted responder in this suite reads the older shape, so the
 * wrapper hands each one the context as it looked before: `systemPrompt` and
 * `tools` replayed from the system messages, and `messages` without them.
 */
import { type Context, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  type FauxResponseStep,
  getModel,
  registerFauxProvider as registerTranscriptFauxProvider,
  streamSimple,
} from "@earendil-works/pi-ai/compat";

export { getModel, streamSimple };

/** The pre-0.86 `Context` view of a transcript, as the suite's responders expect it. */
export function toLegacyContext(context: { messages: Context["messages"] }): Context {
  return {
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages),
    messages: context.messages.filter((message) => message.role !== "system"),
  };
}

function withLegacyContext(step: FauxResponseStep): FauxResponseStep {
  if (typeof step !== "function") return step;
  return (context, options, state) => step(toLegacyContext(context) as never, options, state);
}

export function registerFauxProvider(...args: Parameters<typeof registerTranscriptFauxProvider>) {
  const registration = registerTranscriptFauxProvider(...args);
  const setResponses = registration.setResponses.bind(registration);
  const appendResponses = registration.appendResponses.bind(registration);
  registration.setResponses = (steps) => setResponses(steps.map(withLegacyContext));
  registration.appendResponses = (steps) => appendResponses(steps.map(withLegacyContext));
  return registration;
}
