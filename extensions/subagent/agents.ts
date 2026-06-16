/**
 * Agent discovery and configuration
 */

/// <reference types="node" />

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "./bucket-selector.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Bucket hint for model selection: "small", "medium", or "frontier". */
	bucket?: string;
	/** Optional thinking level hint for model selection. */
	thinkingLevel?: ThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) {
		return path.resolve(configured);
	}
	return path.join(os.homedir(), ".pi", "agent");
}

function parseFrontmatter<T extends Record<string, string>>(content: string): { frontmatter: T; body: string } {
	if (!content.startsWith("---")) {
		return { frontmatter: {} as T, body: content };
	}

	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {} as T, body: content };
	}

	const [, rawFrontmatter, body] = match;
	const frontmatter = {} as Record<string, string>;
	for (const line of rawFrontmatter.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		if (!key) continue;
		const rawValue = line.slice(separator + 1).trim();
		frontmatter[key] = rawValue.replace(/^['"]|['"]$/g, "");
	}

	return { frontmatter: frontmatter as T, body };
}

const VALID_BUCKETS = new Set(["small", "medium", "frontier"]);
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh"]);

/**
 * Parse a frontmatter `tools` value into a list of tool names. Accepts both a
 * comma-separated string (`read, write`) and inline YAML list syntax
 * (`[read, write]`), stripping surrounding brackets and per-item quotes.
 */
function parseToolsList(rawTools: string | undefined): string[] | undefined {
	if (!rawTools) return undefined;
	const inner = rawTools.trim().replace(/^\[|\]$/g, "");
	const tools = inner
		.split(",")
		.map((t) => t.trim().replace(/^['"]|['"]$/g, "").trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseBucketAndThinking(rawBucket: string | undefined, rawThinking: string | undefined): { bucket?: string; thinkingLevel?: ThinkingLevel } {
	const bucket = rawBucket?.trim();
	const thinking = rawThinking?.trim() as ThinkingLevel | undefined;
	return {
		bucket: bucket && VALID_BUCKETS.has(bucket) ? bucket : undefined,
		thinkingLevel: thinking && VALID_THINKING_LEVELS.has(thinking) ? thinking : undefined,
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

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
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = parseToolsList(frontmatter.tools);

		const { bucket, thinkingLevel } = parseBucketAndThinking(frontmatter.bucket, frontmatter.thinkingLevel);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			bucket,
			thinkingLevel,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
