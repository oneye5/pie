import type { Skill } from "@mariozechner/pi-coding-agent";
import type { PruningConfig, ScoredSkill, SkillScoreCacheEntry, SkillTriggers, ThresholdResult } from "./types.js";

const STOP_WORDS = new Set([
	"a", "an", "and", "or", "the", "is", "are", "of", "to", "in", "on", "for", "with", "this", "that", "by", "at", "as", "be", "it", "its", "from", "into", "when", "use", "do", "not", "using",
]);
const CONNECTOR_WORDS = new Set(["and", "or", "for", "the"]);
let warnedPinnedCeiling = false;

function clamp(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function tokenizeRaw(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function normalizeTriggerPhrase(phrase: string): string {
	return phrase
		.toLowerCase()
		.replace(/[.,;:!?]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function extractTriggers(description: string): SkillTriggers {
	const triggers: SkillTriggers = { positive: [], negative: [] };
	const sentences = description.split(/\.\s+|\.$/);

	for (const rawSentence of sentences) {
		const sentence = rawSentence.trim();
		if (!sentence) continue;

		const negativeMatch = sentence.match(/^do not use (?:for|when)\s+(.+)$/i);
		if (negativeMatch) {
			triggers.negative.push(...splitTriggerClause(negativeMatch[1]));
			continue;
		}

		const positiveMatch = sentence.match(/^use (?:when|for)\s+(.+)$/i);
		if (positiveMatch) {
			triggers.positive.push(...splitTriggerClause(positiveMatch[1]));
		}
	}

	return triggers;
}

function splitTriggerClause(clause: string): string[] {
	return clause
		.split(",")
		.map(normalizeTriggerPhrase)
		.filter((phrase) => phrase.length > 0);
}

function intersectionCount(left: Set<string>, right: Set<string>): number {
	let count = 0;
	for (const token of left) {
		if (right.has(token)) count++;
	}
	return count;
}

export function computeTriggerMatch(query: string, triggers: SkillTriggers): number {
	const queryTokens = new Set(tokenize(query));
	let positiveScore = 0;

	for (const trigger of triggers.positive) {
		const triggerTokens = tokenize(trigger);
		const triggerSet = new Set(triggerTokens);
		const overlapCount = intersectionCount(queryTokens, triggerSet);
		const overlap = overlapCount / Math.max(1, triggerTokens.length);
		const score = overlapCount > 0 ? clamp(overlap + 0.3) : overlap;
		positiveScore = Math.max(positiveScore, score);
	}

	let negativePenalty = 0;
	for (const trigger of triggers.negative) {
		const triggerTokens = tokenize(trigger);
		const negOverlap = intersectionCount(queryTokens, new Set(triggerTokens)) / Math.max(1, triggerTokens.length);
		if (negOverlap > 0.5) {
			negativePenalty = Math.max(negativePenalty, negOverlap * 0.5);
		}
	}

	return clamp(positiveScore - negativePenalty);
}

export function computeKeywordOverlap(query: string, text: string, nameTokens: string[] = []): number {
	const queryTokens = new Set(tokenize(query));
	const nameTokenSet = new Set(nameTokens);
	const textTokens = new Set([...tokenize(text), ...nameTokens]);

	let intersectionWeighted = 0;
	for (const token of queryTokens) {
		if (textTokens.has(token)) intersectionWeighted++;
		// Jaccard is set-based, so a true 2x bag weight is not directly representable.
		// Interpret the plan's name-token weighting as one extra intersection hit when
		// the query token also matches a skill-name token, while the union remains set-based.
		if (nameTokenSet.has(token)) intersectionWeighted++;
	}

	const union = new Set([...queryTokens, ...textTokens]);
	return clamp(intersectionWeighted / Math.max(1, union.size));
}

export function computeNameMatch(query: string, name: string): number {
	const queryLower = query.toLowerCase();
	const nameLower = name.toLowerCase();
	if (queryLower.includes(nameLower)) {
		return 1;
	}

	const queryTokens = new Set(tokenizeRaw(query));
	const nameParts = nameLower.split("-").filter((part) => part.length > 0 && !CONNECTOR_WORDS.has(part));
	if (nameParts.length === 0) {
		return 0;
	}

	let matched = 0;
	for (const part of nameParts) {
		if (queryTokens.has(part)) matched++;
	}

	return matched / nameParts.length;
}

function normalizeScores(scores: number[]): number[] {
	if (scores.length === 0) return [];
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	if (max === min) {
		return scores.map(() => 0.5);
	}
	return scores.map((score) => (score - min) / (max - min));
}

function getCacheEntry(skill: Skill, cache?: Map<string, SkillScoreCacheEntry>): SkillScoreCacheEntry {
	const cached = cache?.get(skill.filePath);
	if (cached) return cached;

	const entry = {
		triggers: extractTriggers(skill.description),
		nameTokens: tokenize(skill.name),
	};
	cache?.set(skill.filePath, entry);
	return entry;
}

export function scoreSkills(
	query: string,
	contextContent: string,
	skills: Skill[],
	_config: PruningConfig,
	cache?: Map<string, SkillScoreCacheEntry>,
): ScoredSkill[] {
	// Context is a secondary bias signal: use the prompt plus only the first 500
	// context characters to avoid making scoring itself context-heavy.
	const combinedQuery = `${query} ${contextContent.slice(0, 500)}`;
	const rawScores = skills.map((skill) => {
		const { triggers, nameTokens } = getCacheEntry(skill, cache);
		return {
			skill,
			name: skill.name,
			triggerScore: computeTriggerMatch(combinedQuery, triggers),
			keywordScore: computeKeywordOverlap(combinedQuery, skill.description, nameTokens),
			nameScore: computeNameMatch(combinedQuery, skill.name),
		};
	});

	const triggerNormalized = normalizeScores(rawScores.map((score) => score.triggerScore));
	const keywordNormalized = normalizeScores(rawScores.map((score) => score.keywordScore));
	const nameNormalized = normalizeScores(rawScores.map((score) => score.nameScore));

	return rawScores.map((score, index) => {
		const triggerN = triggerNormalized[index];
		const keywordN = keywordNormalized[index];
		const nameN = nameNormalized[index];
		return {
			...score,
			triggerNormalized: triggerN,
			keywordNormalized: keywordN,
			nameNormalized: nameN,
			compositeScore: 0.5 * triggerN + 0.3 * keywordN + 0.2 * nameN,
		};
	});
}

function byCompositeDescThenName(a: ScoredSkill, b: ScoredSkill): number {
	return b.compositeScore - a.compositeScore || a.name.localeCompare(b.name);
}

function byNameAsc(a: ScoredSkill, b: ScoredSkill): number {
	return a.name.localeCompare(b.name);
}

function withPinned(skill: ScoredSkill): ScoredSkill {
	return { ...skill, pinned: true };
}

export function applyThreshold(
	scored: ScoredSkill[],
	pinnedNames: string[],
	config: PruningConfig,
): ThresholdResult {
	const pinnedSet = new Set(pinnedNames);
	const scoredByName = new Map(scored.map((skill) => [skill.name, skill]));
	const pinned: ScoredSkill[] = [];

	for (const name of pinnedSet) {
		const skill = scoredByName.get(name);
		if (skill) {
			pinned.push(withPinned(skill));
		} else {
			console.warn(`[skill-pruner] pinned skill '${name}' was not found among candidates`);
		}
	}

	if (pinned.length > config.skills.ceiling && !warnedPinnedCeiling) {
		console.warn("[skill-pruner] pinned skills exceed pruning ceiling; keeping all pinned skills");
		warnedPinnedCeiling = true;
	}

	const nonPinned = scored.filter((skill) => !pinnedSet.has(skill.name));
	const ceilingSlots = Math.max(0, config.skills.ceiling - pinned.length);
	if (ceilingSlots === 0) {
		return { included: pinned, excluded: nonPinned };
	}

	const allEqual = nonPinned.length > 0 && nonPinned.every((skill) => skill.compositeScore === nonPinned[0].compositeScore);
	if (allEqual) {
		const needed = Math.max(0, config.skills.floor - pinned.length);
		const extras = [...nonPinned].sort(byNameAsc).slice(0, Math.min(needed, ceilingSlots));
		const includedNames = new Set(extras.map((skill) => skill.name));
		return {
			included: [...pinned, ...extras],
			excluded: nonPinned.filter((skill) => !includedNames.has(skill.name)),
		};
	}

	const sorted = [...nonPinned].sort(byCompositeDescThenName);
	const maxScore = sorted[0]?.compositeScore ?? 0;
	const threshold = maxScore * config.skills.scoreThreshold;
	const includedNonPinned: ScoredSkill[] = [];
	const includedNames = new Set<string>();

	for (let index = 0; index < sorted.length; index++) {
		const current = sorted[index];
		if (current.compositeScore < threshold) break;

		includedNonPinned.push(current);
		includedNames.add(current.name);

		const next = sorted[index + 1];
		if (next && current.compositeScore - next.compositeScore > maxScore * config.skills.gapThreshold) {
			break;
		}
	}

	for (const candidate of sorted) {
		if (pinned.length + includedNonPinned.length >= config.skills.floor) break;
		if (includedNames.has(candidate.name)) continue;
		includedNonPinned.push(candidate);
		includedNames.add(candidate.name);
	}

	while (pinned.length + includedNonPinned.length > config.skills.ceiling) {
		includedNonPinned.sort(byCompositeDescThenName);
		const removed = includedNonPinned.pop();
		if (!removed) break;
		includedNames.delete(removed.name);
	}

	return {
		included: [...pinned, ...includedNonPinned.sort(byCompositeDescThenName)],
		excluded: nonPinned.filter((skill) => !includedNames.has(skill.name)),
	};
}
