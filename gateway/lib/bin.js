#!/usr/bin/env node
import { $t as WORKBUDDY_APP_EXECUTABLE_ENV, A as outcomeOfFailure, C as travelAllAccounts, F as redactUpstreamText, H as FALLBACK_WORKBUDDY_MODELS, K as deriveCatalog, L as createWorkBuddyShim, O as cooldownOf, Q as WorkBuddyCredentialStore, U as FALLBACK_WORKBUDDY_MODELS_GLOBAL, V as piAiRuntimeInfo, W as WorkBuddyCatalog, Z as WORKBUDDY_AUTH_FILE_ENV, a as readHostHeartbeat, an as findWorkbuddyAppExecutableWithSource, b as checkinAllAccounts, c as WORKBUDDY_CONNECT_VERSION, d as rosterSeenPath, dt as workbuddyOwnAuthPath, f as readPoolProbes, h as oauthStart, ht as WorkBuddyUpstreamClient, m as oauthPoll, mn as writeFileAtomic, nt as defaultDesktopAuthDirs, o as workbuddyHostHeartbeatPath, p as writePoolProbes, pn as hostPeersInfo, q as fallbackModelsFor, r as isHeartbeatProcessAlive, st as legacyWorkbuddyOwnAuthPath, tt as defaultDesktopAuthCandidates, u as describeRosterSeenPayload, v as rankPool, yt as modelIdOfBody } from "./host-heartbeat-DUEu7bdr.js";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/gateway.ts
/**
* Standalone OpenAI-compatible gateway for WorkBuddy models — the Hermes
* (and any OpenAI client) entry point of this package.
*
* What this is. The original plugin is a DeepSeek Harness (DSH) plugin: it
* borrows the host's settings cards, model picker and adapter plumbing, and
* its loopback shim exists to be pointed at by an in-process provider. This
* module takes the SAME host-independent core — the credential store
* (`auth.ts`), the upstream client (`upstream.ts`), the catalog, the
* account-pool ranking, and the shim itself — and runs it as a long-lived
* local server whose address and bearer token are STABLE across restarts,
* because they have to live in a consumer's static config:
*
*   Hermes `config.yaml`:
*     model:
*       provider: custom
*       base_url: http://127.0.0.1:8787/v1
*       api_key: <token from the state dir>
*
* Nothing upstream-facing changed. The shim still applies every wire quirk
* (forced streaming upstream, string `tool_choice`, CLI-shaped headers), the
* whole rescue ladder still runs (channel-gate neutral head, invisible
* perturbation, DSML markup recovery, markup-only retry), pool failover still
* ranks accounts and benches the failed one with the upstream's own reset
* time, and credentials are still the desktop app's sign-in, refreshed on
* demand with a 5-minute margin. What changed is who is on the OTHER side of
* the loopback port, and that the port and secret no longer die with the
* host process.
*
* Region model: one gateway process serves BOTH regions, each on its own
* port, each with its own store / catalog / shim / probe file — the same
* parallel-stack rule the DSH plugin enforces, because the two gateways bill
* different accounts and must never share state. A region with no local
* sign-in serves an EMPTY `/v1/models` (never the static fallback): a picker
* entry that can only 401 is worse than an absent one.
*
* State lives under one directory (`resolveStateDir`), defaulting to
* `$HERMES_HOME/workbuddy` — its own credential copies, vault, pool probes
* and selection files all derive from `$DSH_HOME`, which `serve` points at
* that directory. A `--state-dir` (or `WORKBUDDY_STATE_DIR`) moves the whole
* set together.
*
* @module workbuddy/gateway
*/
/** Both regions, in serving order. */
const GATEWAY_REGIONS = ["cn", "global"];
/** Default loopback port per region; the second region steps aside by one. */
const GATEWAY_DEFAULT_PORTS = {
	cn: 8787,
	global: 8788
};
/** How often the live catalog is refreshed from the upstream, by default. */
const GATEWAY_DEFAULT_REFRESH_MS = 18e5;
/**
* Where the gateway keeps everything it owns.
*
* Precedence: an explicit `--state-dir`, then `$WORKBUDDY_STATE_DIR`, then an
* already-set `$DSH_HOME` (a wrapper or a test that pinned it — never
* silently repointed), then `$HERMES_HOME/workbuddy`, then
* `~/.hermes/workbuddy`. The Hermes default is the point of this fork: the
* gateway is a Hermes-side companion, so its state belongs beside Hermes'
* own, not in the original plugin's `~/.dsh`.
*/
function resolveStateDir() {
	const explicit = nonBlank(process.env["WORKBUDDY_STATE_DIR"]);
	if (explicit !== void 0) return explicit;
	const dshHome = nonBlank(process.env["DSH_HOME"]);
	if (dshHome !== void 0) return dshHome;
	const hermesHome = nonBlank(process.env["HERMES_HOME"]) ?? join(homedir(), ".hermes");
	return join(hermesHome, "workbuddy");
}
/**
* Point every plugin-owned path (`$DSH_HOME` consumers: credential copies,
* vault, pool probes, roster history) at one directory. Called once at the
* top of every CLI entry so `serve` and the read-only commands can never
* disagree about where state lives. An ALREADY-set `$DSH_HOME` wins — a test
* or a wrapper that pinned it is obeyed, not overwritten.
*/
function useWorkbuddyStateDir(stateDir) {
	if (nonBlank(process.env["DSH_HOME"]) === void 0) process.env["DSH_HOME"] = stateDir;
}
function nonBlank(value) {
	return value !== void 0 && value.trim() !== "" ? value.trim() : void 0;
}
/** Minimal console logger in the shim's shape. */
const logger = {
	warn: (...args) => {
		process.stderr.write(`workbuddy gateway: ${fmt(args)}\n`);
	},
	error: (...args) => {
		process.stderr.write(`workbuddy gateway: ${fmt(args)}\n`);
	}
};
function fmt(args) {
	return args.map((arg) => arg instanceof Error ? arg.stack ?? arg.message : String(arg)).join(" ");
}
/**
* Whether one upstream body is a session-TITLE prompt from Hermes.
*
* Fail-closed by construction: the signature is the exact opening of Hermes'
* title template PLUS the two-message shape it always sends (system + the
* user's opening message). Anything else — including a future Hermes title
* template this build doesn't know — is left untouched, so the worst a wrong
* flag can do is be a no-op. The upstream shim has its own detector for the
* ORIGINAL host's template; this one exists because that detector is
* host-template-specific and no-ops on Hermes' differently-worded prompt
* (measured on the wire: the request kept its paid model until this check).
*/
function isHermesTitleBody(bodyJson) {
	try {
		const messages = JSON.parse(bodyJson).messages;
		if (!Array.isArray(messages) || messages.length !== 2) return false;
		const [system, user] = messages;
		return system?.role === "system" && typeof system.content === "string" && system.content.startsWith("You name chat sessions.") && user?.role === "user";
	} catch {
		return false;
	}
}
/** One body with its `model` replaced (used only for confirmed title prompts). */
function withModel(bodyJson, model) {
	const parsed = JSON.parse(bodyJson);
	parsed["model"] = model;
	return JSON.stringify(parsed);
}
/**
* Append one JSONL diagnostic line for the request log (see
* {@link ServeOptions.logRequests}). Fire-and-forget by design; the file is
* 0600 like the rest of the state dir and carries only counts and model ids —
* never prompt text or tokens.
*/
async function appendRequestLog(stateDir, region, entry) {
	const line = JSON.stringify({
		ts: (/* @__PURE__ */ new Date()).toISOString(),
		region,
		...entry
	});
	await appendFile(join(stateDir, `requests.${region}.jsonl`), `${line}\n`, { mode: 384 });
}
function selectionFilePath(stateDir, region) {
	return join(stateDir, `selection.${region}.json`);
}
function modelsFilePath(stateDir, region) {
	return join(stateDir, `models.${region}.json`);
}
/** The user's persisted account choice for one region, if any. */
async function readSelection(stateDir, region) {
	try {
		const parsed = JSON.parse(await readFile(selectionFilePath(stateDir, region), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const accountId = parsed["accountId"];
		return typeof accountId === "string" && accountId !== "" ? accountId : void 0;
	} catch {
		return;
	}
}
/** Persist (or clear, with `undefined`) the user's account choice. */
async function writeSelection(stateDir, region, accountId) {
	const path = selectionFilePath(stateDir, region);
	if (accountId === void 0) {
		await rm(path, { force: true });
		return;
	}
	await writeFileAtomic(path, `${JSON.stringify({ accountId }, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	});
}
/** The user's model enable-list for one region; empty set = all models. */
async function readEnabledModels(stateDir, region) {
	try {
		const parsed = JSON.parse(await readFile(modelsFilePath(stateDir, region), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return /* @__PURE__ */ new Set();
		const enabled = parsed["enabled"];
		if (!Array.isArray(enabled)) return /* @__PURE__ */ new Set();
		return new Set(enabled.filter((id) => typeof id === "string" && id !== ""));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
/** Persist a model enable-list for one region (empty = serve everything). */
async function writeEnabledModels(stateDir, region, enabled) {
	const path = modelsFilePath(stateDir, region);
	if (enabled.length === 0) {
		await rm(path, { force: true });
		return;
	}
	await writeFileAtomic(path, `${JSON.stringify({ enabled }, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	});
}
/** Read-or-mint the gateway bearer. A generated token is 0600 in the state dir. */
async function resolveGatewayToken(stateDir, explicit) {
	if (explicit !== void 0) return explicit;
	const path = join(stateDir, "gateway-token");
	try {
		const existing = (await readFile(path, "utf8")).trim();
		if (existing !== "") return existing;
	} catch {}
	const fromEnv = nonBlank(process.env["WORKBUDDY_GATEWAY_TOKEN"]);
	if (fromEnv !== void 0) return fromEnv;
	const minted = randomBytes(32).toString("base64url");
	await writeFile(path, `${minted}\n`, { mode: 384 });
	await chmod(path, 384);
	return minted;
}
/**
* One region's pool members: every account the store can see, each with its
* last stored measurement.
*
* The DSH plugin gated membership on an explicit tick per account; a
* standalone gateway has no card to tick on, so membership IS discovery —
* every local sign-in is a candidate to bill, and `--no-pool` is the single
* switch that reverts to one-account-at-a-time behaviour.
*/
async function poolMembers(stack) {
	const [accounts, probesRecord] = await Promise.all([stack.store.accounts().catch(() => []), readPoolProbes(stack.region).catch(() => ({}))]);
	const probes = probesRecord;
	return accounts.map((account) => ({
		account: {
			id: account.id,
			accountName: account.accountName,
			...account.enterprise === void 0 ? {} : { enterprise: account.enterprise }
		},
		...probes[account.id] === void 0 ? {} : { probe: probes[account.id] },
		tokenExpiresAtMs: account.tokenExpiresAtMs
	}));
}
/** The one-line reason an exclusion excludes, for the failure reply. */
const EXCLUSION_TEXT = {
	"unusable": "账号当前不可用",
	"rate-limited": "账号在限流冷却中",
	"model-busy": "模型负载冷却中",
	"out-of-credit": "账号积分已用尽",
	"credential-rejected": "凭据已被拒绝，需重新登录",
	"account-restricted": "账号被上游限制使用",
	"not-found": "账号不存在",
	"unavailable": "账号暂不可用",
	"failed": "账号上次请求失败，冷却中"
};
/** Persist what a failed live request taught us about one account. */
async function recordAccountFailure(stack, accountId, failure) {
	const outcome = outcomeOfFailure(failure.status, failure.message);
	if (outcome === "ok") return;
	const { retryAtMs } = cooldownOf({
		outcome,
		retryAfter: null,
		nowMs: Date.now(),
		body: failure.message
	});
	const message = failure.message === "" ? "" : redactUpstreamText(failure.message);
	await writePoolProbes(stack.region, { [accountId]: {
		outcome,
		atMs: Date.now(),
		source: "live-request",
		...failure.modelId === void 0 ? {} : { modelId: failure.modelId },
		...retryAtMs === void 0 ? {} : { retryAtMs },
		...message === "" ? {} : { message }
	} });
}
/**
* Run `serve`: bind every requested region, refresh catalogs, publish the
* state file, and stay up until a signal arrives.
*
* Resolves only on shutdown; every startup failure rejects (a port in use is
* the expected one), because a gateway that silently serves nothing is worse
* than one that refuses to start.
*/
async function runGateway(options) {
	const { stateDir } = options;
	await mkdir(stateDir, {
		recursive: true,
		mode: 448
	});
	useWorkbuddyStateDir(stateDir);
	const client = new WorkBuddyUpstreamClient();
	const token = await resolveGatewayToken(stateDir, options.token);
	const stacks = /* @__PURE__ */ new Map();
	for (const region of options.regions) {
		const store = new WorkBuddyCredentialStore({
			region,
			refresh: (credential) => client.refreshToken(credential)
		});
		const selected = await readSelection(stateDir, region);
		if (selected !== void 0) store.selectAccount(selected);
		const catalog = new WorkBuddyCatalog(region);
		/**
		* Every upstream attempt gets one JSONL line BEFORE the shim's rescue
		* ladder sees the result — including refused attempts, which a usage-only
		* log would miss even though the upstream bills them. Fired without
		* awaiting: a diagnostic must never delay the request it describes.
		*/
		let usageInFlight;
		const loggingClient = options.logRequests === true || options.sessionTitleModel !== void 0 ? { chatStream: (credential, rawBodyJson, signal) => {
			const bodyJson = options.sessionTitleModel !== void 0 && isHermesTitleBody(rawBodyJson) ? withModel(rawBodyJson, options.sessionTitleModel) : rawBodyJson;
			const modelId = modelIdOfBody(bodyJson);
			const startedMs = Date.now();
			if (options.logRequests === true) appendRequestLog(stateDir, region, {
				kind: "attempt",
				model: modelId,
				...process.env["WORKBUDDY_LOG_BODIES"] === "1" ? { preview: bodyJson.slice(0, 400) } : {}
			}).catch(() => {});
			usageInFlight = { ...modelId === void 0 ? {} : { modelId } };
			return client.chatStream(credential, bodyJson, signal).then((result) => {
				if (options.logRequests === true) appendRequestLog(stateDir, region, {
					kind: "attempt-done",
					model: modelId,
					ok: result.ok,
					...result.ok ? {} : {
						status: result.status,
						upstream: result.kind
					},
					ms: Date.now() - startedMs
				}).catch(() => {});
				return result;
			});
		} } : client;
		const shim = createWorkBuddyShim({
			store,
			client: loggingClient,
			catalog,
			logger,
			port: options.ports[region],
			token,
			channelPerturbation: options.channelPerturbation,
			keepPromptLast: options.keepPromptLast,
			...options.sessionTitleModel === void 0 ? {} : { sessionTitle: {
				enabled: true,
				model: options.sessionTitleModel
			} },
			...options.logRequests ? { onUpstreamUsage: (usage) => {
				appendRequestLog(stateDir, region, {
					kind: "usage",
					...usageInFlight?.modelId === void 0 ? {} : { model: usageInFlight.modelId },
					promptTokens: usage.promptTokens,
					completionTokens: usage.completionTokens,
					cachedTokens: usage.cachedTokens
				}).catch(() => {});
			} } : {},
			...options.pool ? {
				prepareAccount: async () => {
					const selection = await readSelection(stateDir, region).catch(() => void 0);
					store.selectAccount(selection);
					if (!options.pool) return;
					const winner = rankPool(await poolMembers({
						region,
						store
					}), Date.now()).find((row) => row.excludedBy === void 0);
					store.setRotatedAccount(winner?.account.id);
				},
				failoverAccount: async (triedAccountIds) => {
					const ranked = rankPool(await poolMembers({
						region,
						store
					}), Date.now());
					for (const row of ranked) {
						if (row.excludedBy !== void 0) continue;
						if (triedAccountIds.includes(row.account.id)) continue;
						return store.credentialFor(row.account.id);
					}
				},
				failoverShortfall: async () => {
					const excluded = rankPool(await poolMembers({
						region,
						store
					}), Date.now()).filter((row) => row.excludedBy !== void 0);
					if (excluded.length === 0) return void 0;
					return `池中其余账号都被排除：${[...new Set(excluded.map((row) => EXCLUSION_TEXT[row.excludedBy]))].join("、")}`;
				},
				onAccountFailure: (accountId, failure) => {
					recordAccountFailure({ region }, accountId, {
						status: failure.status,
						message: failure.message,
						...failure.modelId === void 0 ? {} : { modelId: failure.modelId }
					}).catch((error) => logger.warn(`${region} failure measurement not stored`, error));
				}
			} : {}
		});
		await shim.ready;
		stacks.set(region, {
			region,
			store,
			catalog,
			shim,
			modelIds: []
		});
	}
	const writeStateFile = async () => {
		const document = {
			version: 1,
			pid: process.pid,
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			stateDir,
			tokenFile: "gateway-token",
			regions: Object.fromEntries([...stacks.values()].map((stack) => [stack.region, {
				baseUrl: `${stack.shim.baseUrl()}/v1`,
				port: options.ports[stack.region],
				modelIds: stack.modelIds
			}]))
		};
		await writeFileAtomic(join(stateDir, "gateway.json"), `${JSON.stringify(document, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	};
	/**
	* Record whether this region has any local sign-in — the gate on what
	* /v1/models advertises.
	*
	* Awaited BEFORE `ready` is announced: until the first account scan lands,
	* a fresh catalog serves the static fallback with `usable` still true, and
	* a signed-out gateway would advertise models that can only 401 for the
	* first seconds of its life (a race the built e2e test caught under load).
	* The upstream host tolerated that window because its picker re-rendered;
	* a static consumer config does not.
	*/
	const resolveUsable = async (stack) => {
		const usable = (await stack.store.accounts().catch(() => [])).length > 0;
		stack.catalog.setRegionUsable(usable);
		return usable;
	};
	/** Refresh one region's live catalog; degrade to the fallback on failure. */
	const refreshCatalog = async (stack) => {
		if (!await resolveUsable(stack)) {
			stack.modelIds = [];
			logger.warn(`${stack.region}: no local WorkBuddy sign-in; /v1/models serves nothing until you sign in`);
			return;
		}
		const credential = await stack.store.resolve();
		const models = await client.fetchModels(credential);
		const enabled = await readEnabledModels(stateDir, stack.region);
		stack.catalog.set(deriveCatalog(models, enabled));
		stack.modelIds = stack.catalog.current().map((model) => model.id);
		logger.warn(`${stack.region}: catalog refreshed — ${stack.modelIds.length} model(s)`);
	};
	const refreshAll = () => {
		for (const stack of stacks.values()) refreshCatalog(stack).then(() => writeStateFile()).catch((error) => logger.warn(`${stack.region}: catalog refresh failed; serving the static fallback`, error));
	};
	await Promise.all([...stacks.values()].map((stack) => resolveUsable(stack)));
	refreshAll();
	const refreshTimer = setInterval(refreshAll, options.refreshMs);
	refreshTimer.unref();
	await writeStateFile();
	for (const stack of stacks.values()) process.stdout.write([
		`workbuddy gateway: ${stack.region} serving ${stack.shim.baseUrl()} (port ${options.ports[stack.region]})`,
		`  token: ${join(stateDir, "gateway-token")}`,
		`  hermes: model.provider=custom  model.base_url=${stack.shim.baseUrl()}/v1  model.api_key=<token>`,
		""
	].join("\n"));
	process.stdout.write("workbuddy gateway: ready\n");
	await new Promise((resolveShutdown) => {
		let closing = false;
		const shutdown = (signal) => {
			if (closing) return;
			closing = true;
			process.stdout.write(`workbuddy gateway: ${signal} received, shutting down\n`);
			clearInterval(refreshTimer);
			(async () => {
				for (const stack of stacks.values()) await stack.shim.close().catch(() => {});
				await rm(join(stateDir, "gateway.json"), { force: true }).catch(() => {});
				resolveShutdown();
			})();
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}
//#endregion
//#region src/bin.ts
/**
* Standalone status/diagnostics CLI for the dsh-connect-workbuddy bundle.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
*   — 三个子命令（`doctor` / `status` / `logout`）、`--json` 输出、
*     `safeMessage` 脱敏、schemaVersion 字段、以及
*     「宿主心跳 + 桌面端凭据文件 + 登录态」三项联合诊断的结构，
*     均由该项目设计。
* 改动：凭据诊断由单文件扩展为「目录扫描 + 按账号分组」，
*     doctor 会列出发现的每个账号及其文件来源，便于确认多账号是否可用；
*     另补 desktopAuthDir 字段。双 provider 化后，doctor/status 按
*     区域（cn | global）分别报告各自的账号与登录态，logout 清除
*     所有插件自有凭据副本（两个区域文件 + 旧单文件）。
*
* @module dsh-connect-workbuddy/bin
*/
/** Actions added for standalone (host-less) use, e.g. behind Hermes. */
const STANDALONE_ACTIONS = /* @__PURE__ */ new Set([
	"serve",
	"models",
	"credits",
	"checkin",
	"travel",
	"account",
	"login"
]);
/**
* Version of the `doctor --json` document.
*
* 3 → 4: added `hostPeers` (issue #47). Consumers that switch on the version
* see the field appear rather than having to guess whether its absence means
* "old build" or "no peer".
*
* 4 → 5: added `rosterSeen`, so a first-sighting history that is corrupt or in
* a version this build cannot read is REPORTED rather than silently answered as
* "no new models".
*/
const JSON_SCHEMA_VERSION = 5;
/** Both regions, in reporting order. */
const REGIONS = ["cn", "global"];
/** Region labels for human output. */
const REGION_LABELS = {
	cn: "CN (domestic)",
	global: "Global"
};
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: workbuddy <command> [options]",
		"",
		"Gateway (standalone OpenAI-compatible endpoint for Hermes and other clients):",
		"  serve     run the local gateway (per-region loopback port; stable port + token)",
		"            --region cn|global|both (default both)",
		"            --port N (cn port; global becomes N+1) / --port-cn N / --port-global N",
		"            --token STR (else the state dir's gateway-token, minted 0600 on first run)",
		"            --state-dir DIR (default $WORKBUDDY_STATE_DIR or $HERMES_HOME/workbuddy)",
		"            --no-pool (disable account-pool rotation/failover)",
		"            --refresh-minutes N (live catalog refresh, default 30)",
		"            --channel-perturbation off|failure|always   --keep-prompt-last",
		"            --log-requests (JSONL per upstream attempt/usage in the state dir; for request-count audits)",
		"            --session-title-model ID (bill title-shaped requests at this model; e.g. hy3 = free)",
		"",
		"Account & model management:",
		"  login     sign in through the browser (no desktop app needed) and store the account",
		"            --region cn|global (default cn)   --base URL (global-region brand base)",
		"  models    list a region's models, or edit its enable-list",
		"            --region cn|global (default cn)  --json",
		"            --enable id1,id2   --disable id1,id2   (persisted; gateway picks it up)",
		"  account   list / select the billing account for a region",
		"            --region cn|global (default cn)  [list] [<id|name>]  --clear",
		"  credits   per-account remaining credit   --region cn|global|both (default both) --json",
		"  travel    Buddy travel (派猫猫): claim a landed reward, then dispatch   --region cn|global|both",
		"            --status (read-only: report the trip, claim nothing)   --location 1-4   --json",
		"",
		"  checkin   claim every account's daily reward   --region cn|global|both (default both) --json",
		"",
		"Diagnostics (unchanged from the original plugin):",
		"  doctor    secret-free sign-in and environment diagnostics",
		"  status    per-region sign-in state, remaining credit, host-bundle health",
		"  logout    remove every plugin-owned credential copy (the desktop app keeps its sign-in)",
		"  --json    emit one secret-free JSON document (doctor/status only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** One region-scoped credential store (its own plugin-owned copy file). */
function makeStore(region) {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({
		region,
		refresh: (credential) => client.refreshToken(credential)
	});
}
/** The region-unscoped store (reads every plugin-owned copy). */
function makeAnyStore() {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
}
/**
* Read one region's first-sighting history and describe its payload.
*
* Read-only: this CLI never writes history, so running `doctor` cannot change
* who counts as new. The point is that a corrupt file or one written by a newer
* build is REPORTED here — without this, both would surface as "no new models",
* which is a statement about this machine's catalogue and never a file.
*/
async function describeRosterSeen(region) {
	const path = rosterSeenPath(region);
	let raw = null;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch {
		raw = null;
	}
	const described = describeRosterSeenPayload(raw);
	if (described === null) return {
		path,
		present: raw !== null,
		readable: false
	};
	const version = raw["version"];
	return {
		path,
		present: true,
		readable: true,
		versionKnown: described.versionKnown,
		...typeof version === "number" ? { version } : {},
		ids: described.ids,
		fresh: described.fresh
	};
}
async function doctor(jsonOutput) {
	const anyStore = makeAnyStore();
	const desktopPresent = await anyStore.desktopFilePresent();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const discoveredApp = findWorkbuddyAppExecutableWithSource();
	const appExecutable = discoveredApp?.executable;
	const regionLists = await Promise.all(REGIONS.map(async (region) => ({
		region,
		accounts: await makeStore(region).accounts()
	})));
	const anySignedIn = regionLists.some(({ accounts }) => accounts.length > 0);
	/**
	* Which pi-ai copy the PROVIDER resolves, and hence which context shape its
	* api consumes. This is the #24/#26 gate made visible: a legacy (0.85)
	* resolution while the DSH host normalizes with 0.87 is exactly the mixed
	* generation the adapter has to bridge, and the only way to SEE it is to
	* report it. `resolvedLocally: false` is the normal state of a market
	* install probed outside the host — inside DSH the host supplies pi-ai
	* (0.2.0+ ships 0.87.1, i.e. the pass-through branch). Nothing here reads
	* or reports key material.
	*/
	const piAi = piAiRuntimeInfo();
	/**
	* Which atomic-write implementation this process would use (issue #47).
	*
	* The mirror of the `piAiRuntime` block below, for the same reason: the
	* plugin declares `@deepseek-ai/dsh-atomic-write` as a PEER, so inside a
	* booted host the host's copy is borrowed, while under `dsh plugin …
	* exec` the child resolves with stock Node rules and the peer is absent. A
	* missing peer used to be a load-time crash; it is now reported here so a
	* user can tell the two states apart without reading a stack trace.
	*/
	const hostPeers = await hostPeersInfo();
	const rosterSeen = await Promise.all(REGIONS.map(async (region) => ({
		region,
		summary: await describeRosterSeen(region)
	})));
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-connect-workbuddy",
		version: WORKBUDDY_CONNECT_VERSION,
		node: process.version,
		piAiRuntime: {
			generation: piAi.generation,
			version: piAi.version ?? (piAi.resolvedLocally ? "(unreadable)" : "(host-provided)"),
			resolvedFrom: piAi.resolvedFrom ?? "(host-provided; not resolvable outside DSH)",
			resolvedLocally: piAi.resolvedLocally,
			adapterBehaviour: piAi.generation === "legacy" ? "folds 0.87 transcripts (system text + tool state) into the 0.85 context shape" : piAi.resolvedLocally ? "passes provider contexts through unchanged" : "passes provider contexts through unchanged (pi-ai comes from the DSH host; 0.2.0+ ships 0.87.1)"
		},
		hostPeers: {
			atomicWrite: hostPeers.atomicWrite,
			behaviour: hostPeers.atomicWrite === "host" ? "using @deepseek-ai/dsh-atomic-write from the DSH host" : "using the built-in copy: the host peer did not resolve here, which is the normal state outside a booted DSH (e.g. `dsh plugin … exec`)"
		},
		desktopAuthFile: {
			path: anyStore.desktopAuthPath() ?? "(no platform default; set WORKBUDDY_AUTH_FILE)",
			dir: defaultDesktopAuthDirs()[0] ?? "(no platform default)",
			candidates: defaultDesktopAuthCandidates(),
			present: desktopPresent
		},
		/**
		* Whether the encrypted-credential path is available. The desktop app
		* encrypts token fields on Windows builds; opening them needs that same
		* app, so an install location is exactly what this records. No key
		* material is read or reported here.
		*/
		atRestDecryption: {
			appExecutable: appExecutable ?? `(not found; set WORKBUDDY_APP_EXECUTABLE)`,
			/**
			* Where the path came from. `registry` means the app is installed outside
			* the default layout and the Windows uninstall registration found it; the
			* absence of this field (older reports) is why the hint below can now name
			* the mechanism instead of telling every user to set the env var.
			*/
			appExecutableSource: discoveredApp?.source,
			available: appExecutable !== void 0
		},
		ownAuthFiles: {
			cn: workbuddyOwnAuthPath("cn"),
			global: workbuddyOwnAuthPath("global"),
			legacy: legacyWorkbuddyOwnAuthPath()
		},
		hostHeartbeat: {
			path: workbuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		regions: Object.fromEntries(regionLists.map(({ region, accounts }) => [region, accounts.map((account) => ({
			id: account.id,
			accountName: account.accountName,
			domain: account.domain === "" ? void 0 : account.domain,
			source: account.source,
			selected: account.selected,
			tokenExpiresAt: new Date(account.tokenExpiresAtMs).toISOString()
		}))])),
		fallbackModels: {
			cn: FALLBACK_WORKBUDDY_MODELS.length,
			global: FALLBACK_WORKBUDDY_MODELS_GLOBAL.length
		},
		rosterSeen: Object.fromEntries(rosterSeen.map(({ region, summary }) => [region, summary])),
		hints: [
			...anySignedIn ? [] : ["Sign in once in the WorkBuddy desktop app (either region), then run status again."],
			...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set ${WORKBUDDY_AUTH_FILE_ENV} if it lives elsewhere.`],
			...appExecutable === void 0 ? [`The WorkBuddy desktop app was not found, so encrypted credential fields cannot be opened. On Windows the install registration was already checked, so the app is either not installed or its uninstall entry is missing; set ${WORKBUDDY_APP_EXECUTABLE_ENV} to its executable if it is installed elsewhere.`] : [],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and providers are unavailable until DSH starts the plugin."],
			...piAi.generation === "legacy" && piAi.resolvedLocally ? [`This plugin resolves pi-ai ${piAi.version ?? "(unreadable version)"} (the 0.85 context shape) while DSH 0.2.0+ hosts normalize with 0.87; the adapter bridges that gap, but if tools still misbehave, remove any nested pi-ai copy so the plugin resolves the host's.`] : [],
			...rosterSeen.flatMap(({ region, summary }) => {
				if (!summary.readable) return summary.present ? [`${REGION_LABELS[region]} first-sighting history is present but unreadable (${summary.path}); remove it to reseed on the next reconcile.`] : [];
				if (summary.versionKnown === false) return [`${REGION_LABELS[region]} first-sighting history is version ${summary.version === void 0 ? "unknown" : summary.version}, which this build cannot read (${summary.path}); it is answered as empty, so the pill shows no new-model marker.`];
				return [];
			})
		]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`WorkBuddy Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
		...piAi.resolvedLocally ? [`pi-ai runtime: ${piAi.generation}${piAi.version === void 0 ? "" : ` ${piAi.version}`} (${piAi.resolvedFrom}) — ${report.piAiRuntime.adapterBehaviour}`] : [`pi-ai runtime: ${piAi.generation}, host-provided (no local copy; DSH 0.2.0+ ships 0.87.1) — passes provider contexts through unchanged`],
		`Atomic writes: ${hostPeers.atomicWrite === "host" ? "host-provided (@deepseek-ai/dsh-atomic-write)" : "built-in copy (host peer not resolvable here; normal outside a booted DSH)"}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} (${report.desktopAuthFile.path})`,
		`Encrypted-credential support: ${report.atRestDecryption.available ? "available" : "unavailable"} (${report.atRestDecryption.appExecutable}${report.atRestDecryption.appExecutableSource === void 0 ? "" : `, via ${report.atRestDecryption.appExecutableSource}`})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		...regionLists.flatMap(({ region, accounts }) => [`${REGION_LABELS[region]} accounts: ${accounts.length} (own copy ${workbuddyOwnAuthPath(region)})`, ...accounts.map((account) => `  - ${account.accountName === "" ? "(unnamed)" : account.accountName} (${account.id})${account.selected ? " [selected]" : ""} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`)]),
		`Static fallback models: CN ${report.fallbackModels.cn}, Global ${report.fallbackModels.global}`,
		...REGIONS.map((region) => {
			const summary = report.rosterSeen[region];
			if (summary === void 0) return `New-model history (${REGION_LABELS[region]}): not available`;
			if (!summary.readable) return `New-model history (${REGION_LABELS[region]}): ${summary.present ? "unreadable" : "not started"} (${summary.path})`;
			if (summary.versionKnown === false) return `New-model history (${REGION_LABELS[region]}): version ${summary.version === void 0 ? "unknown" : summary.version} not readable (${summary.path})`;
			return `New-model history (${REGION_LABELS[region]}): ${summary.ids ?? 0} recorded, ${summary.fresh ?? 0} new`;
		}),
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return anySignedIn && desktopPresent ? 0 : 1;
}
/** One region's sign-in and credit summary. */
async function regionStatus(region) {
	const store = makeStore(region);
	const client = new WorkBuddyUpstreamClient();
	const authStatus = await store.status();
	const accounts = await store.accounts();
	const selected = accounts.find((account) => account.selected);
	const base = {
		region,
		status: authStatus.state,
		...authStatus.expiresAtMs === void 0 ? {} : { accessTokenExpires: new Date(authStatus.expiresAtMs).toISOString() },
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...selected === void 0 ? {} : {
			accountId: selected.id,
			accountName: selected.accountName
		},
		accountCount: accounts.length
	};
	if (authStatus.state !== "signed-in") return base;
	try {
		const credential = await store.resolve();
		return {
			...base,
			credits: (await client.fetchCredits(credential)).total
		};
	} catch (error) {
		return {
			...base,
			credits: 0,
			creditsError: safeMessage(error)
		};
	}
}
async function status(jsonOutput) {
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	const fragments = await Promise.all(REGIONS.map((region) => regionStatus(region)));
	const cn = fragments.find((fragment) => fragment.region === "cn");
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-connect-workbuddy",
			version: WORKBUDDY_CONNECT_VERSION,
			status: cn?.status === "signed-in" ? "signed-in" : "signed-out",
			...cn?.status === "signed-in" ? {
				...cn.accessTokenExpires === void 0 ? {} : { accessTokenExpires: cn.accessTokenExpires },
				...cn.nickname === void 0 ? {} : { nickname: cn.nickname },
				...cn.domain === void 0 ? {} : { domain: cn.domain },
				...cn.accountId === void 0 ? {} : {
					accountId: cn.accountId,
					accountName: cn.accountName
				}
			} : {},
			regions: Object.fromEntries(fragments.map((fragment) => [fragment.region, fragment])),
			hostBundle: hostState
		});
		return fragments.some((fragment) => fragment.status === "signed-in") ? 0 : 1;
	}
	process.stdout.write([
		...fragments.flatMap((fragment) => [
			`${REGION_LABELS[fragment.region]}: ${fragment.status === "signed-in" ? `signed in${fragment.accountName === void 0 ? "" : ` as ${fragment.accountName}`}` : "signed out"}`,
			...fragment.status === "signed-in" && fragment.accessTokenExpires !== void 0 ? [`  Access token expires ${fragment.accessTokenExpires} (refresh is automatic)`] : [],
			`  Local accounts: ${fragment.accountCount}`,
			...fragment.creditsError !== void 0 ? [`  Remaining credit: unavailable (${fragment.creditsError})`] : fragment.credits !== void 0 ? [`  Remaining credit: ${fragment.credits}`] : []
		]),
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host providers are unaffected.",
		...await describeGatewayLines(),
		""
	].join("\n"));
	return fragments.some((fragment) => fragment.status === "signed-in") ? 0 : 1;
}
/** Parse an argv tail of `--flag`, `--key value`, `--key=value`, positionals. */
function parseFlags(argv) {
	const flags = /* @__PURE__ */ new Set();
	const values = /* @__PURE__ */ new Map();
	const positionals = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		if (equals !== -1) {
			values.set(arg.slice(2, equals), arg.slice(equals + 1));
			continue;
		}
		const next = argv[index + 1];
		if (next !== void 0 && !next.startsWith("--")) {
			values.set(arg.slice(2), next);
			index += 1;
			continue;
		}
		flags.add(arg.slice(2));
	}
	return {
		flags,
		values,
		positionals
	};
}
/** Resolve `--region` into the region list a command should act on. */
function parseRegions(value, fallback) {
	if (value === void 0) return fallback;
	if (value === "both") return GATEWAY_REGIONS;
	if (value === "cn" || value === "global") return [value];
	throw new Error(`--region must be cn, global, or both; got ${JSON.stringify(value)}`);
}
function parsePort(value, fallback) {
	if (value === void 0) return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`port must be an integer in 1024..65535; got ${JSON.stringify(value)}`);
	return port;
}
/** `workbuddy serve` — run the OpenAI-compatible gateway until a signal lands. */
async function serveCommand(argv) {
	const { flags, values } = parseFlags(argv);
	const regions = parseRegions(values.get("region"), GATEWAY_REGIONS);
	const basePort = values.get("port");
	const ports = {
		cn: parsePort(values.get("port-cn") ?? basePort, GATEWAY_DEFAULT_PORTS.cn),
		global: parsePort(values.get("port-global") ?? (basePort === void 0 ? void 0 : String(Number(basePort) + 1)), GATEWAY_DEFAULT_PORTS.global)
	};
	if (regions.length === 2 && ports.cn === ports.global) throw new Error(`both regions cannot share port ${ports.cn}; pass --port-cn/--port-global`);
	const perturbation = values.get("channel-perturbation") ?? "failure";
	if (perturbation !== "off" && perturbation !== "failure" && perturbation !== "always") throw new Error(`--channel-perturbation must be off, failure, or always; got ${JSON.stringify(perturbation)}`);
	const refreshMinutes = values.get("refresh-minutes");
	if (refreshMinutes !== void 0) {
		const minutes = Number(refreshMinutes);
		if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--refresh-minutes must be a positive number; got ${JSON.stringify(refreshMinutes)}`);
	}
	const token = values.get("token");
	await runGateway({
		regions,
		ports,
		...token === void 0 ? {} : { token },
		stateDir: values.get("state-dir") ?? resolveStateDir(),
		pool: !flags.has("no-pool"),
		refreshMs: refreshMinutes === void 0 ? GATEWAY_DEFAULT_REFRESH_MS : Math.round(Number(refreshMinutes) * 6e4),
		channelPerturbation: perturbation,
		keepPromptLast: flags.has("keep-prompt-last"),
		logRequests: flags.has("log-requests"),
		...values.get("session-title-model") === void 0 ? {} : { sessionTitleModel: values.get("session-title-model") }
	});
	return 0;
}
function modelRowOf(model) {
	return {
		id: model.id,
		...model.name === void 0 ? {} : { name: model.name },
		...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
		...model.creditMultiplier === void 0 ? {} : { creditMultiplier: model.creditMultiplier },
		...model.supportsImages === void 0 ? {} : { supportsImages: model.supportsImages },
		...model.reasoning === void 0 ? {} : { reasoning: model.reasoning }
	};
}
/** `workbuddy models` — list a region's models or edit its enable-list. */
async function modelsCommand(argv) {
	const { flags, values } = parseFlags(argv);
	const region = parseRegions(values.get("region"), ["cn"])[0];
	const stateDir = values.get("state-dir") ?? resolveStateDir();
	const current = await readEnabledModels(stateDir, region);
	const enable = values.get("enable");
	const disable = values.get("disable");
	if (enable !== void 0 || disable !== void 0) {
		const next = new Set(current);
		for (const id of splitList(enable)) next.add(id);
		for (const id of splitList(disable)) next.delete(id);
		await writeEnabledModels(stateDir, region, [...next]);
		process.stdout.write(next.size === 0 ? `${region}: no enable-list kept; every discovered model is served\n` : `${region}: enable-list saved (${next.size}): ${[...next].join(", ")}\n`);
		return 0;
	}
	const store = makeStore(region);
	const client = new WorkBuddyUpstreamClient();
	let rows;
	let source;
	try {
		const credential = await store.resolve();
		rows = (await client.fetchModels(credential)).map(modelRowOf);
		source = "live";
	} catch {
		rows = fallbackModelsFor(region).map(modelRowOf);
		source = "fallback";
	}
	const visible = current.size === 0 ? rows : rows.filter((row) => current.has(row.id));
	const served = visible.length === 0 && current.size > 0 ? rows : visible;
	if (values.has("json") || flags.has("json")) {
		printJson({
			region,
			source,
			enabled: [...current],
			models: served
		});
		return 0;
	}
	process.stdout.write([
		`${REGION_LABELS[region]} models (${source}${source === "fallback" ? " — no local sign-in or upstream unreachable; run `workbuddy status`" : ""}): ${served.length}`,
		...served.map((row) => [
			`  ${row.id}`,
			row.name === void 0 ? "" : ` — ${row.name}`,
			row.contextWindow === void 0 ? "" : ` · ctx ${row.contextWindow}`,
			row.creditMultiplier === void 0 ? "" : ` · ×${row.creditMultiplier} credits`,
			row.supportsImages === true ? " · images" : ""
		].join("")),
		""
	].join("\n"));
	return 0;
}
function splitList(value) {
	return (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}
/** `workbuddy credits` — remaining credit per account, per region. */
async function creditsCommand(argv) {
	const { flags, values } = parseFlags(argv);
	const regions = parseRegions(values.get("region"), GATEWAY_REGIONS);
	const client = new WorkBuddyUpstreamClient();
	const report = {};
	const lines = [];
	let anyCredit = false;
	for (const region of regions) {
		const store = makeStore(region);
		const accounts = await store.accounts();
		const rows = [];
		for (const account of accounts) {
			const credential = await store.credentialFor(account.id);
			if (credential === void 0) continue;
			try {
				const credits = await client.fetchCredits(credential);
				anyCredit = true;
				rows.push({
					accountId: account.id,
					accountName: account.accountName === "" ? "(unnamed)" : account.accountName,
					total: credits.total,
					expiringSoon: credits.expiringSoon,
					...credits.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: credits.nearestExpiryMs }
				});
			} catch (error) {
				rows.push({
					accountId: account.id,
					accountName: account.accountName === "" ? "(unnamed)" : account.accountName,
					error: safeMessage(error)
				});
			}
		}
		report[region] = rows;
		lines.push(`${REGION_LABELS[region]}:`, ...rows.length === 0 ? ["  (no local accounts)"] : rows.map((row) => {
			const record = row;
			return record.error === void 0 ? `  ${record.accountName}: ${record.total} credit${record.expiringSoon ? ` (${record.expiringSoon} expiring soon)` : ""}` : `  ${record.accountName}: unavailable (${record.error})`;
		}));
	}
	if (flags.has("json") || values.has("json")) {
		printJson(report);
		return 0;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return anyCredit ? 0 : 1;
}
/** `workbuddy checkin` — claim every account's daily reward. */
async function checkinCommand(argv) {
	const { flags, values } = parseFlags(argv);
	const regions = parseRegions(values.get("region"), GATEWAY_REGIONS);
	const client = new WorkBuddyUpstreamClient();
	const report = {};
	const lines = [];
	let anySuccess = false;
	for (const region of regions) {
		const store = makeStore(region);
		const accounts = await store.accounts();
		const rows = await checkinAllAccounts(accounts.map((account) => ({
			accountId: account.id,
			accountName: account.accountName,
			...account.enterprise === void 0 ? {} : { enterprise: account.enterprise }
		})), {
			credentialFor: (accountId) => store.credentialFor(accountId),
			fetchCheckinStatus: (credential) => client.fetchCheckinStatus(credential),
			claimDailyCheckin: (credential) => client.claimDailyCheckin(credential),
			probe: async () => {
				throw new Error("probe is not part of the checkin command");
			}
		});
		for (const row of rows) if (row.status === "claimed") anySuccess = true;
		report[region] = rows;
		lines.push(`${REGION_LABELS[region]}:`, ...rows.length === 0 ? ["  (no local accounts)"] : rows.map((row) => [
			`  ${row.accountName === "" ? row.accountId : row.accountName}: ${row.status}`,
			row.credit === void 0 ? "" : ` +${row.credit}`,
			row.streakDays === void 0 ? "" : ` (streak ${row.streakDays}d)`,
			row.message === void 0 ? "" : ` — ${row.message}`
		].join("")));
	}
	if (flags.has("json") || values.has("json")) {
		printJson(report);
		return 0;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return anySuccess ? 0 : 1;
}
/**
* `workbuddy travel` — Buddy travel (派猫猫) on every stored account.
*
* A guardrail, not a nicety: the closed loop claims an `arrived` reward FIRST
* and only then dispatches, because an unclaimed landing blocks a departure and
* a reward that is never claimed is simply lost (the server keeps `arrived`,
* but the next trip never starts).
*
* Exit code: 0 when at least one account ended in a better state than it
* started (claimed / departed), 1 otherwise — `traveling` and `limit` are normal
* steady states, not errors, so a run that finds them exits 1 only to say "this
* run changed nothing".
*/
async function travelCommand(argv) {
	const { flags, values } = parseFlags(argv);
	const regions = parseRegions(values.get("region"), GATEWAY_REGIONS);
	const readOnly = flags.has("status") || flags.has("check-only");
	const rawLocation = values.get("location");
	let locationId;
	if (rawLocation !== void 0) {
		const parsed = Number(rawLocation);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) throw new Error(`--location must be an integer in 1..4; got ${JSON.stringify(rawLocation)}`);
		locationId = parsed;
	}
	const client = new WorkBuddyUpstreamClient();
	const report = {};
	const lines = [];
	let anyChange = false;
	for (const region of regions) {
		const store = makeStore(region);
		const accounts = await store.accounts();
		const rows = await travelAllAccounts(accounts.map((account) => ({
			accountId: account.id,
			accountName: account.accountName,
			...account.enterprise === void 0 ? {} : { enterprise: account.enterprise }
		})), {
			credentialFor: (accountId) => store.credentialFor(accountId),
			fetchTravelStatus: (credential) => client.fetchTravelStatus(credential),
			claimTravelReward: (credential) => client.claimTravelReward(credential),
			departBuddy: (credential, id) => client.departBuddy(credential, id)
		}, {
			readOnly,
			...locationId === void 0 ? {} : { locationId }
		});
		for (const row of rows) if (row.status === "claimed" || row.status === "departed" || row.departed === true) anyChange = true;
		report[region] = rows;
		lines.push(`${REGION_LABELS[region]}:`, ...rows.length === 0 ? ["  (no local accounts)"] : rows.map((row) => [
			`  ${row.accountName === "" ? row.accountId : row.accountName}: ${row.status}`,
			row.credit === void 0 ? "" : ` +${row.credit}`,
			row.departed === true && row.status === "claimed" ? " → dispatched" : "",
			row.location === void 0 ? "" : ` · ${row.location}`,
			row.arriveAtMs === void 0 ? "" : ` · lands ${new Date(row.arriveAtMs).toISOString().replace("T", " ").slice(0, 16)}`,
			row.message === void 0 ? "" : ` — ${row.message}`
		].join("")));
	}
	if (flags.has("json") || values.has("json")) {
		printJson(report);
		return 0;
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return anyChange ? 0 : 1;
}
/**
* `workbuddy login` — add an account by signing in through the browser,
* with no desktop app and no credential file to copy.
*
* The upstream issues a state, the user finishes the sign-in on whatever
* device has their browser (the URL carries a code to scan/confirm), and this
* command polls for the token, then stores it in the region's vault — the
* same vault the desktop-file accounts live in, so selection, refresh, the
* pool and every read command treat it identically. This is the path that
* works when the desktop app is on ANOTHER machine (its token fields may be
* encrypted there and unreadable without the app); tokens obtained this way
* are fresh from the OAuth server and stored unencrypted by this tool.
*/
async function loginCommand(argv) {
	const { values } = parseFlags(argv);
	const region = parseRegions(values.get("region"), ["cn"])[0];
	const store = makeStore(region);
	const base = values.get("base");
	const started = await oauthStart(region, base === void 0 ? {} : { base });
	if ("error" in started) {
		process.stderr.write(`workbuddy: could not start the sign-in: ${started.error}\n`);
		return 1;
	}
	const urlFile = join(resolveStateDir(), `login-${region}-url.txt`);
	await mkdir(resolveStateDir(), {
		recursive: true,
		mode: 448
	});
	await writeFile(urlFile, `${started.verificationUri}\n`, { mode: 384 });
	process.stdout.write([
		`WorkBuddy sign-in (${region}): open this URL in a browser and finish the login there —`,
		`  ${started.verificationUri}`,
		`  (also saved to ${urlFile})`,
		`Waiting up to ${Math.round(started.expiresIn / 60)} minutes; Ctrl+C cancels, nothing is stored until it completes.`,
		""
	].join("\n"));
	const deadline = Date.now() + started.expiresIn * 1e3;
	for (;;) {
		const answer = await oauthPoll(started.loginId, region);
		if (answer.done) {
			await rm(urlFile, { force: true }).catch(() => {});
			if ("error" in answer) {
				process.stderr.write(`workbuddy: sign-in failed: ${answer.error}\n`);
				return 1;
			}
			const accountId = await store.addOAuthAccount({
				accessToken: answer.account.accessToken,
				refreshToken: answer.account.refreshToken,
				expiresAtMs: answer.account.expiresAtMs,
				...answer.account.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: answer.account.refreshExpiresAtMs },
				domain: answer.account.domain,
				uid: answer.account.uid,
				...answer.account.nickname === void 0 ? {} : { nickname: answer.account.nickname },
				...answer.account.uin === void 0 ? {} : { uin: answer.account.uin },
				...answer.account.enterpriseId === void 0 ? {} : { enterpriseId: answer.account.enterpriseId }
			});
			const saved = (await store.accounts().catch(() => [])).find((account) => account.id === accountId);
			process.stdout.write([
				`${region}: signed in as ${saved?.accountName === void 0 || saved.accountName === "" ? accountId : `${saved.accountName} (${accountId})`}`,
				`Run \`workbuddy models --region ${region}\` to list the live catalog; a running gateway picks the account up on its next request.`,
				""
			].join("\n"));
			return 0;
		}
		if (Date.now() > deadline) {
			process.stderr.write("workbuddy: the sign-in window expired; run `workbuddy login` again\n");
			return 1;
		}
		await new Promise((resolve) => setTimeout(resolve, 2e3));
	}
}
/** `workbuddy account` — list, select, or clear the billing account. */
async function accountCommand(argv) {
	const { flags, positionals, values } = parseFlags(argv);
	const region = parseRegions(values.get("region"), ["cn"])[0];
	const stateDir = values.get("state-dir") ?? resolveStateDir();
	const store = makeStore(region);
	if (flags.has("clear")) {
		await writeSelection(stateDir, region, void 0);
		store.selectAccount(void 0);
		process.stdout.write(`${region}: selection cleared; the gateway follows the newest sign-in\n`);
		return 0;
	}
	const accounts = await store.accounts();
	const selected = await readSelection(stateDir, region);
	if (positionals.length === 0) {
		process.stdout.write([
			`${REGION_LABELS[region]} accounts: ${accounts.length}`,
			...accounts.map((account) => `  - ${account.accountName === "" ? "(unnamed)" : account.accountName} (${account.id})${account.id === selected ? " [selected]" : ""}${account.enterprise === true ? " [enterprise]" : ""} expires ${new Date(account.tokenExpiresAtMs).toISOString()}`),
			""
		].join("\n"));
		return 0;
	}
	const query = positionals[0];
	const match = accounts.find((account) => account.id === query) ?? accounts.find((account) => account.accountName !== "" && account.accountName === query);
	if (match === void 0) {
		process.stderr.write(`workbuddy: no ${region} account matches ${JSON.stringify(query)}; see \`workbuddy account --region ${region}\`\n`);
		return 1;
	}
	await writeSelection(stateDir, region, match.id);
	store.selectAccount(match.id);
	process.stdout.write(`${region}: billing account set to ${match.accountName === "" ? match.id : `${match.accountName} (${match.id})`}; a running gateway applies it on the next request\n`);
	return 0;
}
/** Whether a pid is alive; used only to label a stale gateway state file. */
function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** What `status` adds about a running gateway, if its state file exists. */
async function describeGatewayLines() {
	const stateDir = resolveStateDir();
	let document;
	try {
		document = JSON.parse(await readFile(join(stateDir, "gateway.json"), "utf8"));
	} catch {
		return ["Gateway: not started (no state file; run `workbuddy serve`)"];
	}
	return [`Gateway: ${isPidAlive(document.pid) ? `running (pid ${document.pid}, started ${document.startedAt})` : "not running (stale state file)"}`, ...Object.entries(document.regions).map(([region, info]) => `  ${region}: ${info.baseUrl} — ${info.modelIds.length} live model(s)`)];
}
/** Execute one boot-free command. */
async function run(argv) {
	useWorkbuddyStateDir(resolveStateDir());
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (rawAction !== void 0 && STANDALONE_ACTIONS.has(rawAction)) try {
		switch (rawAction) {
			case "serve": return await serveCommand(flags);
			case "models": return await modelsCommand(flags);
			case "credits": return await creditsCommand(flags);
			case "checkin": return await checkinCommand(flags);
			case "travel": return await travelCommand(flags);
			case "account": return await accountCommand(flags);
			case "login": return await loginCommand(flags);
			default: return 1;
		}
	} catch (error) {
		process.stderr.write(`workbuddy: ${rawAction} failed: ${safeMessage(error)}\n`);
		return 1;
	}
	if (![
		"doctor",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`workbuddy: unknown command ${JSON.stringify(rawAction)}; expected serve, models, account, credits, checkin, travel, doctor, status, or logout (see --help)\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	if (flags.filter((flag) => flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-connect-workbuddy: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput);
			case "status": return await status(jsonOutput);
			case "logout":
				await makeAnyStore().logout();
				process.stdout.write(`WorkBuddy Connect: removed the plugin-owned credential copies (${workbuddyOwnAuthPath("cn")}, ${workbuddyOwnAuthPath("global")}, ${legacyWorkbuddyOwnAuthPath()}); the desktop app's sign-in is untouched\n`);
				return 0;
			default: return 1;
		}
	} catch (error) {
		process.stderr.write(`dsh-connect-workbuddy: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
