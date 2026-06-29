/**
 * web-access-compat — startup self-heal for the `pi-web-access` extension.
 *
 * WHY THIS EXISTS
 *
 * `pi-web-access@0.13.0` (the latest release) imports the subpath
 * `@earendil-works/pi-ai/compat`. The host `@earendil-works/pi-ai` (bundled
 * inside `@earendil-works/pi-coding-agent` 0.74.x) no longer exports
 * `./compat` — that compat shim was dropped once its symbols (`complete`,
 * `StringEnum`, `getModel`, …) lived in the main entry. Worse: pi's extension
 * loader aliases `@earendil-works/pi-ai` to a *file* (`dist/index.js`), so the
 * subpath resolves to the invalid `dist/index.js/compat` and the whole
 * extension fails to load. Its three tools — `web_search`, `fetch_content`,
 * `get_search_content` — then become "ghost tools": listed in
 * `pruning.tools.alwaysKeep` but never registered, so neither the main agent
 * nor subagents can make web calls.
 *
 * A second, environment-specific failure compounds this on Windows: when npm
 * cannot replace a file during install (e.g. a previous pi process still had
 * it open) it renames it out of the way as `<name>.DELETE.<hash>`; if the
 * replacement write also fails the real file is left missing and the
 * package's `node_modules` is corrupted, again breaking load.
 *
 * WHAT IT DOES
 *
 * At extension-load time — and `pie/extensions/*` are discovered *before*
 * package entries, so this runs before `pi-web-access/index.ts` is loaded —
 * it:
 *   1. Locates the installed `pi-web-access` package with no hardcoded paths
 *      (queries `npm root -g` / `pnpm root -g`, exactly like pi's own
 *      `getGlobalNpmRoot`), so it works on every machine.
 *   2. Rewrites every `@earendil-works/pi-ai/compat` import to
 *      `@earendil-works/pi-ai`. Every runtime symbol pi-web-access needs
 *      already lives in the main entry; `Model`/`Message` are type-only and
 *      erased at runtime, so this is a safe, behaviour-preserving rewrite.
 *   3. Repairs `.DELETE.<hash>` corruption — renaming each artifact back to
 *      its original name only when no real file occupies that name.
 *
 * It is idempotent and forward-compatible: if `pi-web-access` drops the
 * `./compat` import upstream (or `pi-ai` re-adds the export) every step
 * becomes a no-op. It registers no tools. It never throws — a failure here
 * must not break the rest of extension loading.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** Matches `@earendil-works/pi-ai/compat` only when it ends a string/import. */
const COMPAT_REGEX = /@earendil-works\/pi-ai\/compat(?=["')])/g;
const COMPAT_TO = "@earendil-works/pi-ai";
/** `@mozilla/readability`'s `index.js` `require()`s this; missing it = corrupted. */
const READABILITY_ENTRY = "@mozilla/readability/Readability.js";

/** Rewrite the `./compat` subpath import to the main `@earendil-works/pi-ai` entry. */
export function patchCompatInSource(content: string): string {
	return content.replace(COMPAT_REGEX, COMPAT_TO);
}

/** True for npm's "could not replace" rename artifacts, e.g. `Readability.js.DELETE.e9020…`. */
export function isDeleteArtifact(name: string): boolean {
	return /\.DELETE\..+$/.test(name);
}

/** Strip the `.DELETE.<hash>` suffix to recover the original file name. */
export function stripDeleteSuffix(name: string): string {
	const idx = name.indexOf(".DELETE.");
	return idx === -1 ? name : name.slice(0, idx);
}

/**
 * Patch the `./compat` import in `pi-web-access`'s top-level `.ts`/`.js`
 * sources. Returns the number of files written. Idempotent.
 */
export function patchCompatFiles(root: string): number {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	let patched = 0;
	for (const name of entries) {
		if (!/\.(ts|js)$/i.test(name)) continue;
		const full = path.join(root, name);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;
		let content: string;
		try {
			content = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		const next = patchCompatInSource(content);
		if (next === content) continue;
		try {
			writeFileSync(full, next);
			patched++;
		} catch {
			/* read-only fs — leave as-is */
		}
	}
	return patched;
}

/** Yield every real (non-symlink) file under `dir`, recursively. */
function* walkFiles(dir: string): Iterable<string> {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			yield* walkFiles(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

/**
 * Repair npm's `.DELETE.<hash>` corruption under `root`: rename each artifact
 * back to its original name, but only when no real file already occupies that
 * name (npm may have written a fresh copy we must keep). Returns the count
 * restored. Idempotent.
 */
export function repairDeleteArtifacts(root: string): number {
	let restored = 0;
	for (const file of walkFiles(root)) {
		const name = path.basename(file);
		if (!isDeleteArtifact(name)) continue;
		const base = path.join(path.dirname(file), stripDeleteSuffix(name));
		if (existsSync(base)) continue;
		try {
			renameSync(file, base);
			restored++;
		} catch {
			/* leave as-is */
		}
	}
	return restored;
}

/**
 * Probe whether `@mozilla/readability` loads — its `index.js` requires
 * `./Readability`, so a missing `Readability.js` (renamed to `.DELETE.<hash>`)
 * is a reliable, cheap signal that `node_modules` is corrupted.
 */
export function readabilityIntact(root: string): boolean {
	try {
		const req = createRequire(path.join(root, "package.json"));
		return existsSync(req.resolve(READABILITY_ENTRY));
	} catch {
		return false;
	}
}

/** Apply both fixes to the package at `root`. */
export function applyCompatFixes(root: string): void {
	patchCompatFiles(root);
	if (!readabilityIntact(root)) {
		repairDeleteArtifacts(root);
	}
}

/** Run a shell command and return its trimmed stdout, or `null` on failure. */
export function execText(command: string): string | null {
	try {
		return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

let cachedRoot: string | null | undefined;

/**
 * Locate the installed `pi-web-access` package root. Mirrors pi's own
 * user-scope resolution (`getPnpmGlobalPackagePath ?? join(getGlobalNpmRoot(),
 * name)`): `npm root -g` first (the common case), then `pnpm root -g`. Returns
 * `null` when the package is not installed (nothing to heal). Cached per
 * process. No hardcoded paths — works on every machine.
 */
export function resolvePackageRoot(): string | null {
	if (cachedRoot !== undefined) return cachedRoot;
	for (const command of ["npm root -g", "pnpm root -g"]) {
		const root = execText(command);
		if (!root) continue;
		const pkg = path.join(root, "pi-web-access", "package.json");
		if (existsSync(pkg)) {
			cachedRoot = path.dirname(pkg);
			return cachedRoot;
		}
	}
	cachedRoot = null;
	return null;
}

/**
 * Self-heal entry point. `resolveRoot` is injectable for testing; in production
 * it queries the global package roots. Never throws.
 */
export async function runSelfHeal(resolveRoot: () => string | null = resolvePackageRoot): Promise<void> {
	try {
		const root = resolveRoot();
		if (root) applyCompatFixes(root);
	} catch {
		/* best-effort: never break extension loading */
	}
}

/** pi extension factory — runs the self-heal at load time, before pi-web-access loads. */
export default async function (_pi: ExtensionAPI): Promise<void> {
	await runSelfHeal();
}
