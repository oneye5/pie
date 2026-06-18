import { collapseLeadingSlashes, normalizeSlashes, isUnderCwd } from "./paths";

function splitShellSegments(command: string): string[] {
	return command
		.split(/(?:&&|\|\||\||;|\n)/)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function tokenizeShellSegment(segment: string): string[] {
	return Array.from(segment.matchAll(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g), (match) => {
		const token = match[0] ?? "";
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1);
		}
		return token;
	});
}

function isRecursiveForceRmToken(token: string): { recursive: boolean; force: boolean } {
	if (!token.startsWith("-")) {
		return { recursive: false, force: false };
	}
	const lower = token.toLowerCase();
	if (lower === "--recursive") {
		return { recursive: true, force: false };
	}
	if (lower === "--force") {
		return { recursive: false, force: true };
	}
	if (lower.startsWith("--")) {
		return {
			recursive: lower.includes("recursive"),
			force: lower.includes("force"),
		};
	}
	return {
		recursive: /r/.test(lower),
		force: /f/.test(lower),
	};
}

function isRootDeleteTarget(target: string): boolean {
	const trimmed = collapseLeadingSlashes(normalizeSlashes(target.trim())).toLowerCase();
	if (trimmed === "/" || trimmed === "/*" || trimmed === "~" || trimmed === "~/") {
		return true;
	}
	if (/^[a-z]:\/$/.test(trimmed) || /^"[a-z]:\\"$/i.test(target.trim())) {
		return true;
	}
	return false;
}

export function analyzeRecursiveRm(command: string, cwd: string): { action: "allow" | "block" | "prompt"; reason?: string } | null {
	for (const segment of splitShellSegments(command)) {
		const tokens = tokenizeShellSegment(segment);
		if (tokens.length === 0 || tokens[0]?.toLowerCase() !== "rm") {
			continue;
		}

		let recursive = false;
		let force = false;
		const targets: string[] = [];
		let parsingFlags = true;
		for (let index = 1; index < tokens.length; index += 1) {
			const token = tokens[index] ?? "";
			if (parsingFlags && token === "--") {
				parsingFlags = false;
				continue;
			}
			if (parsingFlags && token.startsWith("-")) {
				const flags = isRecursiveForceRmToken(token);
				recursive ||= flags.recursive;
				force ||= flags.force;
				continue;
			}
			parsingFlags = false;
			targets.push(token);
		}

		if (!recursive || !force || targets.length === 0) {
			continue;
		}

		for (const target of targets) {
			if (isRootDeleteTarget(target)) {
				return { action: "block", reason: "Recursive force-delete on root (/)" };
			}
			if (!isUnderCwd(target, cwd)) {
				return { action: "prompt", reason: "Recursive force-delete outside project directory" };
			}
		}

		return { action: "allow" };
	}

	return null;
}
