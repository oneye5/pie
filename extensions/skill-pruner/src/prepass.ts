import {
	runLlmPruning,
	type CompleteSimpleFn,
	type LlmPruningInput,
	type RecentConversationMessage,
} from "../llm-scorer.js";
import type { PruningConfig } from "../types.js";
import { state, getCompleteFnOverride } from "./state.js";
import {
	ensureCopilotHeaders,
	withCopilotHeaders,
	withCopilotOptions,
	COPILOT_IDE_HEADERS,
} from "./copilot-headers.js";
import type { PrepassRunResult } from "./pruning-types.js";
import { toErrorMessage } from "../../../shared/error-message.js";

export const LLM_TIMEOUT_MS_BY_THINKING_LEVEL: Record<string, number> = {
	minimal: 20_000,
	low: 20_000,
	medium: 25_000,
	high: 30_000,
	xhigh: 35_000,
};

/**
 * Max transport-level retries (5xx / network errors) per thinking-level
 * attempt, with exponential backoff between them. This is distinct from the
 * thinking-level downgrade loop: a transient 500 from the provider gateway
 * must be retried at the SAME reasoning level before we give up on that level
 * and downgrade, otherwise a single gateway blip turns "no text response"
 * fatal with zero transport retries (pi-ai's OpenAI client defaults to
 * `maxRetries: 0`). See OPENAI-SDK retry plumbing: `openai-responses.js`
 * reads `options?.maxRetries ?? 0`.
 */
export const PREPASS_MAX_TRANSPORT_RETRIES = 2;
const PREPASS_TRANSPORT_BACKOFF_BASE_MS = 1_000;

/** Resolve after `ms` milliseconds. Used for transport-retry backoff. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Max recent turns (user+assistant) surfaced to the prepass for follow-up interpretation. */
const RECENT_CONVERSATION_MAX = 6;
/** Per-message text cap so the prepass prompt stays modest. */
const RECENT_MESSAGE_TEXT_LIMIT = 400;
/** Hard ceiling on the backward walk to bound work on long sessions. */
const RECENT_CONVERSATION_WALK_LIMIT = 200;

/**
 * Reduce an AgentMessage's content to a short text summary: text blocks plus a
 * deduplicated `[tools used: ...]` note for assistant actions. Returns "" when
 * there is nothing usable (e.g. a tool-result-only message).
 */
function summarizeMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const textParts: string[] = [];
	const tools: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown; name?: unknown };
		if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
			textParts.push(b.text.trim());
		} else if (b.type === "tool_use" && typeof b.name === "string" && !tools.includes(b.name)) {
			tools.push(b.name);
		}
	}
	const text = textParts.join(" ");
	const toolNote = tools.length > 0 ? ` [tools used: ${tools.join(", ")}]` : "";
	return (text + toolNote).trim();
}

/**
 * Read the most recent user/assistant turns from the session tree so the prepass
 * can interpret follow-up prompts ("fix this", "do that again") in context.
 * Walks backward from the current leaf via parentId, mirroring the SDK's own
 * buildSessionContext walk, and stops at a compaction boundary (earlier messages
 * are summarized there, not raw). Returns [] when no session is available or
 * there is no prior conversation (e.g. the first turn).
 *
 * The current turn's prompt is not yet persisted at before_agent_start time, so
 * it is naturally excluded — it is already supplied separately as `userPrompt`.
 */
export function getRecentConversation(ctx: unknown, maxMessages = RECENT_CONVERSATION_MAX): RecentConversationMessage[] {
	const sessionManager = (ctx as { sessionManager?: unknown })?.sessionManager as {
		getLeafEntry?: () => unknown;
		getEntry?: (id: string) => unknown;
	} | undefined;
	if (!sessionManager?.getLeafEntry || !sessionManager?.getEntry) return [];

	const recent: RecentConversationMessage[] = [];
	const seen = new Set<string>();
	let current: unknown = sessionManager.getLeafEntry();
	let steps = 0;

	while (current && recent.length < maxMessages && steps < RECENT_CONVERSATION_WALK_LIMIT) {
		steps++;
		const entry = current as { id?: unknown; parentId?: unknown; type?: unknown; message?: unknown };
		const id = typeof entry.id === "string" ? entry.id : undefined;
		if (id) {
			if (seen.has(id)) break; // cycle guard
			seen.add(id);
		}
		// Don't cross a compaction boundary — earlier messages are summarized.
		if (entry.type === "compaction") break;

		if (entry.type === "message" && entry.message) {
			const msg = entry.message as { role?: unknown; content?: unknown };
			if (msg.role === "user" || msg.role === "assistant") {
				const text = summarizeMessageContent(msg.content).slice(0, RECENT_MESSAGE_TEXT_LIMIT);
				if (text.length > 0) recent.push({ role: String(msg.role), text });
			}
		}

		const parentId = entry.parentId;
		current = typeof parentId === "string" && parentId.length > 0
			? sessionManager.getEntry(parentId)
			: undefined;
	}

	return recent.reverse();
}

export function getCompleteFn(_ctx: unknown): CompleteSimpleFn | null {
	const override = getCompleteFnOverride();
	if (override === false) return null;
	if (override) return override;

	const adapter: CompleteSimpleFn = async (model, context, options) => {
		if (state._piCompleteSimple === undefined) {
			try {
				const piAi = await import("@earendil-works/pi-ai");
				state._piCompleteSimple = piAi.completeSimple;
			} catch {
				state._piCompleteSimple = null;
			}
		}
		if (!state._piCompleteSimple) {
			throw new Error(
				"@earendil-works/pi-ai is not available; install it (npm install @earendil-works/pi-ai) or run via the pi host that provides it",
			);
		}
		const systemMsg = context.find((m) => m.role === "system");
		const nonSystemMsgs = context.filter((m) => m.role !== "system");
		const piContext = {
			systemPrompt: systemMsg?.content ?? "",
			messages: nonSystemMsgs.map((m) => ({
				role: m.role,
				content: [{ type: "text" as const, text: m.content }],
				timestamp: Date.now(),
			})),
		};

		const safeModel = ensureCopilotHeaders(model as Record<string, unknown>);
		const safeOptions = withCopilotOptions(options, model as Record<string, unknown>);

		const result = await state._piCompleteSimple(safeModel, piContext, safeOptions);
		const assistantMessage = result as {
			content?: Array<{ type: string; text?: string; thinking?: string }>;
			stopReason?: string;
			errorMessage?: string;
			usage?: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
			};
		};
		const content = assistantMessage.content ?? [];
		const text = content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("");
		const thinking = content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking ?? "")
			.join("");
		return {
			text,
			thinking,
			stopReason: assistantMessage.stopReason,
			errorMessage: assistantMessage.errorMessage,
			usage: assistantMessage.usage ? {
				input: assistantMessage.usage.input ?? 0,
				output: assistantMessage.usage.output ?? 0,
				cacheRead: assistantMessage.usage.cacheRead ?? 0,
				cacheWrite: assistantMessage.usage.cacheWrite ?? 0,
			} : undefined,
		};
	};
	return adapter;
}

export function resolveModel(ctx: unknown, _config: PruningConfig): unknown {
	const ctxObj = ctx as Record<string, unknown>;
	const modelRegistry = ctxObj?.modelRegistry as { find?: (provider: string, id: string) => unknown } | undefined;
	if (modelRegistry?.find) {
		const raw = modelRegistry.find(_config.provider, _config.model);
		if (raw && typeof raw === "object") {
			return ensureCopilotHeaders(raw as Record<string, unknown>);
		}
		return raw;
	}
	if (getCompleteFnOverride()) {
		return { id: _config.model, provider: _config.provider, api: "unknown" };
	}
	return undefined;
}

export async function resolveAuth(ctx: unknown, model: unknown): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	const modelObj = model as Record<string, unknown> | null;
	const isCopilot = modelObj?.provider === "github-copilot";

	const ctxObj = ctx as Record<string, unknown>;
	const modelRegistry = ctxObj?.modelRegistry as { getApiKeyAndHeaders?: (model: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }> } | undefined;
	if (modelRegistry?.getApiKeyAndHeaders) {
		const result = await modelRegistry.getApiKeyAndHeaders(model);
		if (result.ok) {
			return { apiKey: result.apiKey, headers: withCopilotHeaders(result.headers, isCopilot) };
		}
	}

	return isCopilot ? { headers: { ...COPILOT_IDE_HEADERS } } : {};
}

export function prepassTimeoutMs(thinkingLevel: string, attemptIndex: number = 0): number {
	const base = LLM_TIMEOUT_MS_BY_THINKING_LEVEL[thinkingLevel] ?? LLM_TIMEOUT_MS_BY_THINKING_LEVEL.minimal;
	return base * (attemptIndex + 1);
}

export function buildPrepassThinkingAttempts(thinkingLevel: string): string[] {
	if (thinkingLevel === "minimal") {
		return [thinkingLevel];
	}
	return [...new Set([thinkingLevel, "minimal"])];
}

export function hasUsablePrepassResponse(result: Awaited<ReturnType<typeof runLlmPruning>>): boolean {
	return result.rawResponse.trim().length > 0;
}

export function formatEmptyPrepassError(result: Awaited<ReturnType<typeof runLlmPruning>>): string {
	const diagnostics: string[] = [];
	if (result.stopReason) {
		diagnostics.push(`stopReason=${result.stopReason}`);
	}
	if (result.errorMessage) {
		diagnostics.push(result.errorMessage);
	}
	if (diagnostics.length === 0) {
		return "LLM pruning failed: returned no text response";
	}
	return `LLM pruning failed: returned no text response (${diagnostics.join("; ")})`;
}

/**
 * Classify a prepass result as a *transport* error worth retrying at the same
 * reasoning level (as opposed to a genuine empty-text response, which gets the
 * thinking-level-downgrade path). Transport errors are transient upstream
 * failures — HTTP 5xx, 429, network/timeout — that another shot may resolve.
 *
 * `stopReason === "error"` combined with an HTTP-status-bearing errorMessage
 * (e.g. `OpenAI API error (500): 500 Internal Server Error`) is the signature
 * pi-ai produces when the OpenAI client surfaces a non-2xx response. We also
 * treat a thrown error whose message carries an HTTP status as transport.
 */
export function isTransportError(result: Awaited<ReturnType<typeof runLlmPruning>> | undefined, thrown?: unknown): boolean {
	if (thrown !== undefined) {
		const msg = toErrorMessage(thrown);
		return /\b(?:5\d\d|429)\b/.test(msg) || /Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg);
	}
	if (!result) return false;
	if (result.stopReason !== "error") return false;
	const msg = result.errorMessage ?? "";
	return /\b(?:5\d\d|429)\b/.test(msg) || /Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(msg);
}

/** Classify a thrown/returned error as a transport error by message alone. */
export function isTransportErrorMessage(message: string): boolean {
	return /\b(?:5\d\d|429)\b/.test(message) || /Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(message);
}

export async function runPruningPrepass(
	ctx: unknown,
	llmInput: LlmPruningInput,
	activeConfig: PruningConfig,
	completeFn: CompleteSimpleFn,
): Promise<PrepassRunResult> {
	const emptyResult = (thinkingLevel: string, error: string | null): PrepassRunResult => ({
		prunedSkills: null,
		prunedTools: null,
		error,
		rawResponse: "",
		rawThinking: "",
		rawSystemPrompt: "",
		rawUserMessage: "",
		latencyMs: 0,
		thinkingLevel,
	});

	// Model resolution and auth run outside the per-attempt retry loop below. A
	// throw here (e.g. a model registry that errors) must not escape this function
	// and surface as a framework-level error; treat it like any other prepass
	// failure so the orchestrator fails open with a visible error message.
	let model: unknown;
	let auth: { apiKey?: string; headers?: Record<string, string> };
	try {
		model = resolveModel(ctx, activeConfig);
		if (!model) {
			return emptyResult(activeConfig.thinkingLevel, `Model '${activeConfig.model}' (provider: ${activeConfig.provider}) not found in registry`);
		}
		auth = await resolveAuth(ctx, model);
	} catch (error) {
		return emptyResult(activeConfig.thinkingLevel, `LLM pruning failed: ${toErrorMessage(error)}`);
	}

	const attempts = buildPrepassThinkingAttempts(activeConfig.thinkingLevel);
	let latestResult = emptyResult(activeConfig.thinkingLevel, null);

	for (let index = 0; index < attempts.length; index++) {
		const thinkingLevel = attempts[index];
		try {
			const result = await runLlmPruning(llmInput, model, {
				reasoning: thinkingLevel,
				// Forward an explicit transport-retry budget so pi-ai's
				// `openai-responses.js` (`maxRetries: options?.maxRetries ?? 0`)
				// retries 5xx/429/timeout at the SDK layer instead of surfacing
				// the first blip as a terminal "no text response".
				maxRetries: PREPASS_MAX_TRANSPORT_RETRIES,
				signal: AbortSignal.timeout(prepassTimeoutMs(thinkingLevel, index)),
				...auth,
			}, completeFn);

			latestResult = {
				prunedSkills: result.prunedSkills,
				prunedTools: result.prunedTools,
				error: null,
				rawResponse: result.rawResponse,
				rawThinking: result.rawThinking,
				rawSystemPrompt: result.systemPrompt,
				rawUserMessage: result.userMessage,
				latencyMs: result.latencyMs,
				thinkingLevel,
				usage: result.usage,
				keptAllDueToParseFailure: result.keptAllDueToParseFailure,
			};

			if (hasUsablePrepassResponse(result)) {
				return latestResult;
			}

			// Transport error (5xx/429/network): retry at the SAME reasoning
			// level with backoff before downgrading. A transient gateway 500
			// must not be treated as a content-empty "no text" response that
			//_downgrades_ the reasoning — that never fixes a transport fault.
			if (isTransportError(result)) {
				let recovered = false;
				for (let r = 1; r <= PREPASS_MAX_TRANSPORT_RETRIES; r++) {
					const backoff = PREPASS_TRANSPORT_BACKOFF_BASE_MS * 2 ** (r - 1);
					console.warn(`[skill-pruner] transport error (attempt ${r}/${PREPASS_MAX_TRANSPORT_RETRIES}); retrying in ${backoff}ms: ${result.errorMessage}`);
					await sleep(backoff);
					try {
						const retryResult = await runLlmPruning(llmInput, model, {
							reasoning: thinkingLevel,
							maxRetries: PREPASS_MAX_TRANSPORT_RETRIES,
							signal: AbortSignal.timeout(prepassTimeoutMs(thinkingLevel, index)),
							...auth,
						}, completeFn);
						if (hasUsablePrepassResponse(retryResult)) {
							latestResult = {
								prunedSkills: retryResult.prunedSkills,
								prunedTools: retryResult.prunedTools,
								error: null,
								rawResponse: retryResult.rawResponse,
								rawThinking: retryResult.rawThinking,
								rawSystemPrompt: retryResult.systemPrompt,
								rawUserMessage: retryResult.userMessage,
								latencyMs: retryResult.latencyMs,
								thinkingLevel,
								usage: retryResult.usage,
								keptAllDueToParseFailure: retryResult.keptAllDueToParseFailure,
							};
							recovered = true;
							break;
						}
						if (!isTransportError(retryResult)) {
							// Non-transport empty response → stop transport-retrying;
							// fall through to the thinking-level downgrade path.
							latestResult.error = formatEmptyPrepassError(retryResult);
							break;
						}
						latestResult.error = formatEmptyPrepassError(retryResult);
					} catch (retryError) {
						const msg = toErrorMessage(retryError);
						latestResult.error = isTransportErrorMessage(msg)
							? `LLM pruning failed (transport): ${msg}`
							: `LLM pruning failed: ${msg}`;
						if (!isTransportErrorMessage(msg)) break;
					}
				}
				if (recovered) return latestResult;
			} else {
				latestResult.error = formatEmptyPrepassError(result);
			}

			if (index < attempts.length - 1) {
				console.warn(`[skill-pruner] ${latestResult.error}; retrying with minimal reasoning`);
			}
		} catch (error) {
			const errorMessage = isTransportErrorMessage(toErrorMessage(error))
				? `LLM pruning failed (transport): ${toErrorMessage(error)}`
				: `LLM pruning failed: ${toErrorMessage(error)}`;

			if (isTransportErrorMessage(toErrorMessage(error))) {
				// Thrown transport error: retry at the SAME reasoning level with
				// backoff (mirrors the returned-error inner loop above). A thrown
				// 503 must be retried even on the final thinking level — gating
				// on `index < attempts.length - 1` would skip the retry when
				// there is no level to downgrade to, surfacing a transient blip
				// as a terminal failure.
				let recovered = false;
				for (let r = 1; r <= PREPASS_MAX_TRANSPORT_RETRIES; r++) {
					const backoff = PREPASS_TRANSPORT_BACKOFF_BASE_MS * 2 ** (r - 1);
					console.warn(`[skill-pruner] ${errorMessage} (attempt ${r}/${PREPASS_MAX_TRANSPORT_RETRIES}); retrying in ${backoff}ms`);
					await sleep(backoff);
					try {
						const retryResult = await runLlmPruning(llmInput, model, {
							reasoning: thinkingLevel,
							maxRetries: PREPASS_MAX_TRANSPORT_RETRIES,
							signal: AbortSignal.timeout(prepassTimeoutMs(thinkingLevel, index)),
							...auth,
						}, completeFn);
						if (hasUsablePrepassResponse(retryResult)) {
							latestResult = {
								prunedSkills: retryResult.prunedSkills,
								prunedTools: retryResult.prunedTools,
								error: null,
								rawResponse: retryResult.rawResponse,
								rawThinking: retryResult.rawThinking,
								rawSystemPrompt: retryResult.systemPrompt,
								rawUserMessage: retryResult.userMessage,
								latencyMs: retryResult.latencyMs,
								thinkingLevel,
								usage: retryResult.usage,
								keptAllDueToParseFailure: retryResult.keptAllDueToParseFailure,
							};
							recovered = true;
							break;
						}
						latestResult.error = formatEmptyPrepassError(retryResult);
						if (!isTransportError(retryResult)) break;
					} catch (retryError) {
						const msg = toErrorMessage(retryError);
						latestResult.error = isTransportErrorMessage(msg)
							? `LLM pruning failed (transport): ${msg}`
							: `LLM pruning failed: ${msg}`;
						if (!isTransportErrorMessage(msg)) break;
					}
				}
				if (recovered) return latestResult;
				if (index < attempts.length - 1) {
					console.warn(`[skill-pruner] ${latestResult.error}; retrying with minimal reasoning`);
					continue;
				}
				console.warn(`[skill-pruner] ${latestResult.error}`);
				return {
					...latestResult,
					prunedSkills: null,
					prunedTools: null,
					error: latestResult.error ?? errorMessage,
					thinkingLevel,
				};
			}

			if (index < attempts.length - 1) {
				latestResult = {
					...latestResult,
					prunedSkills: null,
					prunedTools: null,
					error: errorMessage,
					thinkingLevel,
				};
				console.warn(`[skill-pruner] ${errorMessage}; retrying with minimal reasoning`);
				continue;
			}
			console.warn(`[skill-pruner] ${errorMessage}`);
			return {
				...latestResult,
				prunedSkills: null,
				prunedTools: null,
				error: errorMessage,
				thinkingLevel,
			};
		}
	}

	if (latestResult.error) {
		console.warn(`[skill-pruner] ${latestResult.error}`);
		return latestResult;
	}

	return {
		...latestResult,
		error: "LLM pruning failed: returned no text response",
	};
}
