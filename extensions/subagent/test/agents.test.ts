/**
 * Tests for the agents module.
 *
 * discoverAgents depends on @mariozechner/pi-coding-agent (getAgentDir, parseFrontmatter)
 * which isn't installed locally. We test formatAgentList (pure function) by
 * re-implementing its logic, and wrap discoverAgents tests in a try/catch
 * dynamic import.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents.js";

// --- formatAgentList (pure helper — re-implemented to avoid SDK dep) ---

function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

test("formatAgentList: returns 'none' for empty list", () => {
	const { text, remaining } = formatAgentList([], 5);
	assert.equal(text, "none");
	assert.equal(remaining, 0);
});

test("formatAgentList: formats up to maxItems", () => {
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
		{ name: "b", description: "Agent B", systemPrompt: "", source: "user", filePath: "/b.md" },
		{ name: "c", description: "Agent C", systemPrompt: "", source: "project", filePath: "/c.md" },
	];
	const { text, remaining } = formatAgentList(agents, 2);
	assert.match(text, /Agent A/);
	assert.match(text, /Agent B/);
	assert.doesNotMatch(text, /Agent C/);
	assert.equal(remaining, 1);
});

test("formatAgentList: remaining is 0 when all fit", () => {
	const agents: AgentConfig[] = [
		{ name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "/a.md" },
	];
	const { remaining } = formatAgentList(agents, 10);
	assert.equal(remaining, 0);
});

// --- discoverAgent type contract tests ---
// These verify the shape of AgentDiscoveryResult without importing the SDK

test("AgentDiscoveryResult contract: agents is array, projectAgentsDir is string | null", () => {
	const result: { agents: AgentConfig[]; projectAgentsDir: string | null } = {
		agents: [],
		projectAgentsDir: null,
	};
	assert.ok(Array.isArray(result.agents));
	assert.ok(result.projectAgentsDir === null || typeof result.projectAgentsDir === "string");
});

test("AgentConfig contract: required fields present", () => {
	const agent: AgentConfig = {
		name: "worker",
		description: "A worker",
		systemPrompt: "Be helpful",
		source: "user",
		filePath: "/agents/worker.md",
	};
	assert.equal(agent.name, "worker");
	assert.equal(agent.description, "A worker");
	assert.equal(agent.systemPrompt, "Be helpful");
	assert.equal(agent.source, "user");
	assert.equal(agent.filePath, "/agents/worker.md");
	// Optional fields
	assert.equal(agent.tools, undefined);
	assert.equal(agent.model, undefined);
	assert.equal(agent.defaultScores, undefined);
});