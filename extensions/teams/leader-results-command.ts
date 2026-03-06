import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { TeamTask } from "./task-store.js";

function parseLimit(args: string[], fallback: number): { limit: number; rest: string[]; error?: string } {
	let limit = fallback;
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		if (a === "--limit") {
			const nRaw = args[i + 1];
			if (!nRaw) return { limit, rest: out, error: "Missing value for --limit" };
			const n = Number.parseInt(nRaw, 10);
			if (!Number.isFinite(n) || n <= 0) return { limit, rest: out, error: `Invalid --limit: ${nRaw}` };
			limit = n;
			i += 1;
			continue;
		}
		out.push(a);
	}
	return { limit, rest: out };
}

function parseIds(args: string[]): { ids: Set<string> | null; rest: string[]; error?: string } {
	const out: string[] = [];
	let ids: Set<string> | null = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		if (a === "--ids") {
			const v = args[i + 1];
			if (!v) return { ids: null, rest: out, error: "Missing value for --ids" };
			const parts = v
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			if (!parts.length) return { ids: null, rest: out, error: `Invalid --ids: ${v}` };
			ids = new Set(parts);
			i += 1;
			continue;
		}
		out.push(a);
	}
	return { ids, rest: out };
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

	const parsedLimit = parseLimit(rest, 50);
	if (parsedLimit.error) {
		ctx.ui.notify(`Usage: /team results [completed|all] [--limit N] [--ids 1,2,3]\n${parsedLimit.error}`, "error");
		return;
	}

	const parsedIds = parseIds(parsedLimit.rest);
	if (parsedIds.error) {
		ctx.ui.notify(`Usage: /team results [completed|all] [--limit N] [--ids 1,2,3]\n${parsedIds.error}`, "error");
		return;
	}

	const argsOnly = parsedIds.rest.filter((a) => !a.startsWith("--"));
	if (argsOnly.length > 1) {
		ctx.ui.notify("Usage: /team results [completed|all] [--limit N] [--ids 1,2,3]", "error");
		return;
	}

	const scopeRaw = (argsOnly[0] ?? "completed").trim();
	const scope = scopeRaw === "all" ? "all" : scopeRaw === "completed" ? "completed" : null;
	if (!scope) {
		ctx.ui.notify("Usage: /team results [completed|all] [--limit N] [--ids 1,2,3]", "error");
		return;
	}

	await refreshTasks();
	const tasks = getTasks();

	let selected = tasks.filter((t) => taskHasResult(t));
	if (scope === "completed") selected = selected.filter((t) => t.status === "completed");
	if (parsedIds.ids) {
		const ids = parsedIds.ids;
		selected = selected.filter((t) => ids.has(t.id));
	}

	selected.sort(byNumericIdAsc);

	// default: last N (unless --ids used)
	const limit = parsedIds.ids ? null : parsedLimit.limit;
	if (limit !== null && selected.length > limit) selected = selected.slice(-limit);

	if (!selected.length) {
		ctx.ui.notify(`No task results (scope=${scope} taskListId=${effectiveTlId})`, "info");
		return;
	}

	const blocks: string[] = [];
	blocks.push(`Results (${selected.length}) — scope=${scope} — taskListId=${effectiveTlId}`);
	blocks.push("");
	for (const t of selected) {
		blocks.push(`#${t.id} ${t.subject}`);
		blocks.push(`status: ${t.status}${t.owner ? ` • owner: ${t.owner}` : ""}`);
		blocks.push("");
		blocks.push("result:");
		blocks.push(String(t.metadata?.result ?? "").trimEnd());
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
}
