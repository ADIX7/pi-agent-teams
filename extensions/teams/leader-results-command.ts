import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { TeammateRpc } from "./teammate-rpc.js";
import type { TeamTask } from "./task-store.js";

type Scope = "completed" | "all";

type ParsedOptions = {
	scope: Scope;
	limit: number;
	ids: Set<string> | null;
	summary: boolean;
	model: { provider: string; id: string };
};

const DEFAULT_LIMIT = 50;
const DEFAULT_SUMMARY_MODEL = { provider: "github-copilot", id: "gpt-4o" };

function parseArgs(rest: string[]): { ok: true; opts: ParsedOptions } | { ok: false; error: string } {
	let scope: Scope = "completed";
	let limit = DEFAULT_LIMIT;
	let ids: Set<string> | null = null;
	let summary = false;
	let model = { ...DEFAULT_SUMMARY_MODEL };

	const positionals: string[] = [];

	for (let i = 0; i < rest.length; i++) {
		const a = (rest[i] ?? "").trim();
		if (!a) continue;

		if (a === "--limit") {
			const v = rest[i + 1];
			if (!v) return { ok: false, error: "Missing value for --limit" };
			const n = Number.parseInt(v, 10);
			if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `Invalid --limit: ${v}` };
			limit = n;
			i += 1;
			continue;
		}

		if (a === "--ids") {
			const v = rest[i + 1];
			if (!v) return { ok: false, error: "Missing value for --ids" };
			const parts = v
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			if (!parts.length) return { ok: false, error: `Invalid --ids: ${v}` };
			ids = new Set(parts);
			i += 1;
			continue;
		}

		if (a === "--summary") {
			summary = true;
			continue;
		}

		if (a === "--model") {
			const v = rest[i + 1];
			if (!v) return { ok: false, error: "Missing value for --model" };
			const [p, ...idParts] = v.split("/");
			const id = idParts.join("/");
			if (!p || !id) return { ok: false, error: `Invalid --model: ${v} (expected <provider>/<modelId>)` };
			model = { provider: p, id };
			i += 1;
			continue;
		}

		if (a.startsWith("--")) return { ok: false, error: `Unknown option: ${a}` };
		positionals.push(a);
	}

	if (positionals.length > 1) {
		return { ok: false, error: "Too many positional args" };
	}
	if (positionals.length === 1) {
		const s = positionals[0] ?? "";
		if (s === "completed" || s === "all") scope = s;
		else return { ok: false, error: `Invalid scope: ${s}` };
	}

	return { ok: true, opts: { scope, limit, ids, summary, model } };
}

function taskHasResult(t: TeamTask): boolean {
	return typeof t.metadata?.result === "string" && t.metadata.result.trim().length > 0;
}

function byNumericIdAsc(a: TeamTask, b: TeamTask): number {
	const na = Number.parseInt(a.id, 10);
	const nb = Number.parseInt(b.id, 10);
	if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
	return a.id.localeCompare(b.id, undefined, { numeric: true });
}

async function summarizeResults(opts: {
	tasks: TeamTask[];
	model: { provider: string; id: string };
	cwd: string;
}): Promise<{ summaries: Map<string, string> | null; error?: string }> {
	const { tasks, model, cwd } = opts;

	const input = tasks.map((t) => ({
		id: t.id,
		subject: t.subject,
		result: String(t.metadata?.result ?? ""),
	}));

	const prompt =
		"You summarize task results. For each task, produce a 1-3 line summary. " +
		"You MUST return valid JSON only (no markdown), exactly one entry per input task id. " +
		"Output: an array of objects: {\"id\": string, \"summary\": string}.\n\n" +
		JSON.stringify(input);

	const t = new TeammateRpc("summary-worker");
	try {
		await t.start({
			cwd,
			env: {},
			args: ["--model", `${model.provider}/${model.id}`, "--no-extensions"],
		});

		const done = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Summarization timed out")), 60_000);
			t.onEvent((ev) => {
				if (ev.type === "agent_end") {
					clearTimeout(timeout);
					resolve();
				}
			});
		});

		await t.prompt(prompt);
		await done;

		const raw = t.lastAssistantText.trim();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return { summaries: null, error: "Summarization failed: returned non-JSON. Showing full results." };
		}

		if (!Array.isArray(parsed)) {
			return { summaries: null, error: "Summarization failed: invalid JSON shape. Showing full results." };
		}

		const out = new Map<string, string>();
		for (const item of parsed as unknown[]) {
			if (!item || typeof item !== "object") continue;
			const maybe = item as { id?: unknown; summary?: unknown };
			if (typeof maybe.id !== "string" || typeof maybe.summary !== "string") continue;
			out.set(maybe.id, maybe.summary.trim());
		}

		const missing = tasks.filter((t) => !out.has(t.id)).map((t) => t.id);
		if (missing.length) {
			return {
				summaries: null,
				error: `Summarization failed: missing ids ${missing.join(", ")}. Showing full results.`,
			};
		}

		return { summaries: out };
	} catch (e: unknown) {
		const em = e instanceof Error ? e.message : String(e);
		return { summaries: null, error: `Summarization failed: ${em}. Showing full results.` };
	} finally {
		await t.stop();
	}
}

export async function handleTeamResultsCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	getTaskListId: () => string | null;
	refreshTasks: () => Promise<void>;
	getTasks: () => TeamTask[];
}): Promise<void> {
	const { ctx, rest, teamId, getTaskListId, refreshTasks, getTasks } = opts;

	const effectiveTlId = getTaskListId() ?? teamId;

	const parsed = parseArgs(rest);
	if (!parsed.ok) {
		ctx.ui.notify(
			"Usage: /team results [completed|all] [--limit N] [--ids 1,2,3] [--summary] [--model <provider>/<modelId>]\n" +
				parsed.error,
			"error",
		);
		return;
	}

	await refreshTasks();
	const tasks = getTasks();

	let selected = tasks.filter((t) => taskHasResult(t));
	if (parsed.opts.scope === "completed") selected = selected.filter((t) => t.status === "completed");
	if (parsed.opts.ids) {
		const ids = parsed.opts.ids;
		selected = selected.filter((t) => ids.has(t.id));
	}

	selected.sort(byNumericIdAsc);

	// default: last N (unless --ids used)
	const limit = parsed.opts.ids ? null : parsed.opts.limit;
	if (limit !== null && selected.length > limit) selected = selected.slice(-limit);

	if (!selected.length) {
		ctx.ui.notify(`No task results (scope=${parsed.opts.scope} taskListId=${effectiveTlId})`, "info");
		return;
	}

	let summaries: Map<string, string> | null = null;
	let summaryError: string | null = null;
	if (parsed.opts.summary) {
		const res = await summarizeResults({ tasks: selected, model: parsed.opts.model, cwd: ctx.cwd });
		summaries = res.summaries;
		summaryError = res.error ?? null;
	}

	const blocks: string[] = [];
	blocks.push(
		`Results (${selected.length}) — scope=${parsed.opts.scope} — taskListId=${effectiveTlId}` +
			(parsed.opts.summary ? ` — summaryModel=${parsed.opts.model.provider}/${parsed.opts.model.id}` : ""),
	);
	blocks.push("");

	for (const t of selected) {
		blocks.push(`#${t.id} ${t.subject}`);
		blocks.push(`status: ${t.status}${t.owner ? ` • owner: ${t.owner}` : ""}`);
		blocks.push("");

		if (summaries) {
			blocks.push("summary:");
			blocks.push(String(summaries.get(t.id) ?? "").trimEnd());
		} else {
			blocks.push("result:");
			blocks.push(String(t.metadata?.result ?? "").trimEnd());
		}

		blocks.push("");
		blocks.push("---");
		blocks.push("");
	}

	// Chunk notify output (avoid giant single notify)
	const maxChars = 12_000;
	let cur: string[] = [];
	let curLen = 0;
	const flush = () => {
		if (!cur.length) return;
		ctx.ui.notify(cur.join("\n"), "info");
		cur = [];
		curLen = 0;
	};

	for (const line of blocks) {
		const addLen = line.length + 1;
		if (curLen + addLen > maxChars && cur.length) flush();
		cur.push(line);
		curLen += addLen;
	}
	flush();

	if (summaryError) ctx.ui.notify(summaryError, "error");
}
