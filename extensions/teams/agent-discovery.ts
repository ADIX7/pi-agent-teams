import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project";

export interface TeamAgentProfile {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: TeamAgentProfile[];
	projectAgentsDir: string | null;
	warnings: string[];
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let cur = cwd;
	while (true) {
		const candidate = path.join(cur, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

function loadAgentsFromDir(dir: string, source: AgentSource): TeamAgentProfile[] {
	const agents: TeamAgentProfile[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const thinkingRaw = frontmatter.thinking?.trim();
		const thinking = ((): ThinkingLevel | undefined => {
			if (!thinkingRaw) return undefined;
			if (thinkingRaw === "off" || thinkingRaw === "minimal" || thinkingRaw === "low" || thinkingRaw === "medium" || thinkingRaw === "high" || thinkingRaw === "xhigh") {
				return thinkingRaw;
			}
			return undefined;
		})();

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			thinking,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

export function getTeamsAgentScopeFromEnv(): AgentScope {
	const raw = (process.env.PI_TEAMS_AGENT_SCOPE ?? "both").trim();
	if (raw === "user" || raw === "project" || raw === "both") return raw;
	return "both";
}

export function shouldConfirmProjectAgentsFromEnv(): boolean {
	const v = (process.env.PI_TEAMS_CONFIRM_PROJECT_AGENTS ?? "1").trim();
	return v !== "0";
}

let cachedProjectAgentsApproval: boolean | null = null;

async function confirmProjectAgentsOnce(ctx: ExtensionCommandContext | ExtensionContext, projectAgents: TeamAgentProfile[], projectDir: string): Promise<boolean> {
	if (cachedProjectAgentsApproval !== null) return cachedProjectAgentsApproval;
	if (!shouldConfirmProjectAgentsFromEnv()) {
		cachedProjectAgentsApproval = true;
		return true;
	}

	// Only prompt in interactive TTY mode. In RPC mode, confirm() would require the host to send extension_ui_response messages.
	if (!(process.stdout.isTTY && process.stdin.isTTY)) {
		cachedProjectAgentsApproval = false;
		return false;
	}

	const preview = projectAgents
		.slice(0, 12)
		.map((a) => `- ${a.name}: ${a.description}`)
		.join("\n");
	const remaining = projectAgents.length - Math.min(projectAgents.length, 12);
	const body = `Project agents are repo-controlled prompts/tools/models. Only enable for trusted repos.\n\nDir: ${projectDir}\n\nAgents:\n${preview}${remaining > 0 ? `\n... +${remaining} more` : ""}`;
	const ok = await ctx.ui.confirm("Enable project agents?", body);
	cachedProjectAgentsApproval = ok;
	return ok;
}

export async function discoverTeamAgents(ctx: ExtensionCommandContext | ExtensionContext, scope = getTeamsAgentScopeFromEnv()): Promise<AgentDiscoveryResult> {
	const warnings: string[] = [];
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findNearestProjectAgentsDir(ctx.cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	let projectAgents: TeamAgentProfile[] = [];
	if (scope !== "user" && projectDir) projectAgents = loadAgentsFromDir(projectDir, "project");

	if (projectAgents.length && projectDir) {
		const ok = await confirmProjectAgentsOnce(ctx, projectAgents, projectDir);
		if (!ok) {
			warnings.push("Project agents disabled (not approved). Set PI_TEAMS_CONFIRM_PROJECT_AGENTS=0 to skip confirmation.");
			projectAgents = [];
		}
	}

	const m = new Map<string, TeamAgentProfile>();
	if (scope === "both") {
		for (const a of userAgents) m.set(a.name, a);
		for (const a of projectAgents) m.set(a.name, a);
	} else if (scope === "user") {
		for (const a of userAgents) m.set(a.name, a);
	} else {
		for (const a of projectAgents) m.set(a.name, a);
	}

	return { agents: Array.from(m.values()), projectAgentsDir: projectDir, warnings };
}
