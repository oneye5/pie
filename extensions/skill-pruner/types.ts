import type { Skill } from "@mariozechner/pi-coding-agent";

export type PruningMode = "auto" | "off" | "shadow";

export interface SkillPruningConfig {
	ceiling: number;
	floor: number;
	scoreThreshold: number;
	gapThreshold: number;
	pinned: string[];
}

export interface PruningConfig {
	mode: PruningMode;
	skills: SkillPruningConfig;
}

export interface SkillTriggers {
	positive: string[];
	negative: string[];
}

export interface SkillScoreCacheEntry {
	triggers: SkillTriggers;
	nameTokens: string[];
}

export interface ScoredSkill {
	skill: Skill;
	name: string;
	triggerScore: number;
	keywordScore: number;
	nameScore: number;
	triggerNormalized: number;
	keywordNormalized: number;
	nameNormalized: number;
	compositeScore: number;
	pinned?: boolean;
}

export interface ThresholdResult {
	included: ScoredSkill[];
	excluded: ScoredSkill[];
}

export interface PruningDecisionCandidate {
	name: string;
	triggerScore: number;
	keywordScore: number;
	nameScore: number;
	compositeScore: number;
	included: boolean;
	pinned?: boolean;
}

export interface PruningDecision {
	timestamp: string;
	sessionId: string;
	mode: PruningMode;
	query: string;
	contextFile?: string;
	candidates: PruningDecisionCandidate[];
	pinned: string[];
	included: string[];
	excluded: string[];
	skillBlockTokens: number;
	originalBlockTokens: number;
}
