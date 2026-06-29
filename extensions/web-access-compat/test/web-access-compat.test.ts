/**
 * Tests for the web-access-compat self-heal extension.
 *
 * Covers the pure rewrite/strip helpers and the filesystem patch+repair logic
 * against a real temp-dir "package" (no SDK, no LLM, no network). The
 * env-glue (resolvePackageRoot / the default factory) is exercised only via
 * the injectable `runSelfHeal(resolveRoot)`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyCompatFixes,
	execText,
	isDeleteArtifact,
	patchCompatFiles,
	patchCompatInSource,
	readabilityIntact,
	repairDeleteArtifacts,
	runSelfHeal,
	stripDeleteSuffix,
} from "../index.js";

function makePkg() {
	const root = mkdtempSync(path.join(os.tmpdir(), "wac-"));
	return root;
}

function writePkgFile(root: string, rel: string, content: string, encoding: BufferEncoding = "utf8"): string {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content, encoding);
	return full;
}

// --- execText (shell glue) ---

test("execText returns trimmed stdout for a successful command", () => {
	const out = execText('echo hello');
	assert.equal(out, "hello");
});

test("execText returns null for a failing command", () => {
	assert.equal(execText('exit 1'), null);
});

// --- pure: patchCompatInSource ---

test("patchCompatInSource rewrites a double-quoted static import", () => {
	const out = patchCompatInSource(
		'import { StringEnum, complete, type Model } from "@earendil-works/pi-ai/compat";',
	);
	assert.equal(out, 'import { StringEnum, complete, type Model } from "@earendil-works/pi-ai";');
});

test("patchCompatInSource rewrites a dynamic import() and single quotes", () => {
	const out = patchCompatInSource(
		`const { getModel } = await import('@earendil-works/pi-ai/compat');`,
	);
	assert.equal(out, `const { getModel } = await import('@earendil-works/pi-ai');`);
});

test("patchCompatInSource leaves a longer subpath like /compatibility untouched", () => {
	const src = 'import { x } from "@earendil-works/pi-ai/compatibility";';
	assert.equal(patchCompatInSource(src), src);
});

test("patchCompatInSource is idempotent (already-patched source is unchanged)", () => {
	const src = 'import { complete } from "@earendil-works/pi-ai";';
	assert.equal(patchCompatInSource(src), src);
});

test("patchCompatInSource handles multiple occurrences in one file", () => {
	const out = patchCompatInSource(
		'import { a } from "@earendil-works/pi-ai/compat";\nimport("@earendil-works/pi-ai/compat");',
	);
	assert.equal(out, 'import { a } from "@earendil-works/pi-ai";\nimport("@earendil-works/pi-ai");');
});

// --- pure: delete-artifact helpers ---

test("isDeleteArtifact recognises npm rename artifacts", () => {
	assert.equal(isDeleteArtifact("Readability.js.DELETE.e90203593ab2f7c54e4046ca5ca7f373"), true);
	assert.equal(isDeleteArtifact("index.js.DELETE.abc"), true);
});

test("isDeleteArtifact rejects ordinary file names", () => {
	assert.equal(isDeleteArtifact("Readability.js"), false);
	assert.equal(isDeleteArtifact("index.js"), false);
	assert.equal(isDeleteArtifact("foo.DELETE"), false); // no hash segment
});

test("stripDeleteSuffix recovers the original name", () => {
	assert.equal(
		stripDeleteSuffix("Readability.js.DELETE.e90203593ab2f7c54e4046ca5ca7f373"),
		"Readability.js",
	);
	assert.equal(stripDeleteSuffix("index.js.DELETE.abc"), "index.js");
	assert.equal(stripDeleteSuffix("plain.js"), "plain.js");
});

// --- fs: patchCompatFiles ---

test("patchCompatFiles patches only .ts/.js sources containing the specifier", () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		writeFileSync(
			path.join(root, "summary-review.ts"),
			'import { complete, type Model } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		writeFileSync(path.join(root, "plain.ts"), 'export const x = 1;\n', "utf8");
		writeFileSync(path.join(root, "README.md"), "# nope", "utf8");

		const patched = patchCompatFiles(root);
		assert.equal(patched, 2);
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai";\n',
		);
		assert.equal(
			readFileSync(path.join(root, "summary-review.ts"), "utf8"),
			'import { complete, type Model } from "@earendil-works/pi-ai";\n',
		);
		assert.equal(readFileSync(path.join(root, "plain.ts"), "utf8"), 'export const x = 1;\n');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("patchCompatFiles is idempotent (second run writes nothing)", () => {
	const root = makePkg();
	try {
		const f = path.join(root, "index.ts");
		writeFileSync(f, 'import { complete } from "@earendil-works/pi-ai/compat";\n', "utf8");
		assert.equal(patchCompatFiles(root), 1);
		assert.equal(patchCompatFiles(root), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: repairDeleteArtifacts ---

test("repairDeleteArtifacts renames a .DELETE artifact back when no original exists", () => {
	const root = makePkg();
	try {
		const dir = path.join(root, "node_modules", "@mozilla", "readability");
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", 'require("./Readability");');
		const artifact = path.join(dir, "Readability.js.DELETE.e90203593ab2f7c54e4046ca5ca7f373");
		writeFileSync(artifact, "module.exports = {};", "utf8");

		const restored = repairDeleteArtifacts(root);
		assert.equal(restored, 1);
		assert.equal(existsSync(artifact), false);
		assert.equal(existsSync(path.join(dir, "Readability.js")), true);
		// the unrelated real file is untouched
		assert.equal(
			readFileSync(path.join(dir, "index.js"), "utf8"),
			'require("./Readability");',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repairDeleteArtifacts keeps a .DELETE artifact when a real file already exists", () => {
	const root = makePkg();
	try {
		const dir = path.join(root, "node_modules", "pkg");
		writePkgFile(root, "node_modules/pkg/foo.js", "real", "utf8");
		const artifact = path.join(dir, "foo.js.DELETE.deadbeef");
		writeFileSync(artifact, "stale", "utf8");

		assert.equal(repairDeleteArtifacts(root), 0);
		assert.equal(existsSync(path.join(dir, "foo.js")), true);
		assert.equal(existsSync(artifact), true); // preserved, not clobbered
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repairDeleteArtifacts recurses into nested node_modules", () => {
	const root = makePkg();
	try {
		writePkgFile(
			root,
			"node_modules/@aws-sdk/credential-provider-process/dist-cjs/index.js.DELETE.bee575",
			"old",
			"utf8",
		);
		const restored = repairDeleteArtifacts(root);
		assert.equal(restored, 1);
		assert.equal(
			existsSync(
				path.join(root, "node_modules/@aws-sdk/credential-provider-process/dist-cjs/index.js"),
			),
			true,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("repairDeleteArtifacts is idempotent", () => {
	const root = makePkg();
	try {
		writePkgFile(root, "node_modules/@mozilla/readability/Readability.js.DELETE.hash", "x", "utf8");
		assert.equal(repairDeleteArtifacts(root), 1);
		assert.equal(repairDeleteArtifacts(root), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: readabilityIntact ---

test("readabilityIntact is true when Readability.js resolves", () => {
	const root = makePkg();
	try {
		writePkgFile(root, "package.json", '{"name":"pi-web-access","version":"0.0.0"}', "utf8");
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/package.json",
			'{"name":"@mozilla/readability","main":"index.js"}',
			"utf8",
		);
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/index.js",
			'module.exports={};',
			"utf8",
		);
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/Readability.js",
			"module.exports = {};",
			"utf8",
		);
		assert.equal(readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readabilityIntact is false when Readability.js is missing (corrupted)", () => {
	const root = makePkg();
	try {
		writePkgFile(root, "package.json", '{"name":"pi-web-access","version":"0.0.0"}', "utf8");
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/package.json",
			'{"name":"@mozilla/readability","main":"index.js"}',
			"utf8",
		);
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", 'require("./Readability");', "utf8");
		// no Readability.js — only the .DELETE artifact
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/Readability.js.DELETE.hash",
			"x",
			"utf8",
		);
		assert.equal(readabilityIntact(root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- fs: applyCompatFixes (orchestration) ---

test("applyCompatFixes patches the import AND repairs corruption in one pass", () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		const dir = path.join(root, "node_modules", "@mozilla", "readability");
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", 'require("./Readability");');
		writeFileSync(path.join(dir, "Readability.js.DELETE.hash"), "x", "utf8");
		// no Readability.js present → corruption

		applyCompatFixes(root);

		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai";\n',
		);
		assert.equal(existsSync(path.join(dir, "Readability.js")), true);
		assert.equal(existsSync(path.join(dir, "Readability.js.DELETE.hash")), false);
		assert.equal(readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("applyCompatFixes skips the repair walk when node_modules is healthy", () => {
	const root = makePkg();
	try {
		writeFileSync(path.join(root, "index.ts"), 'import { complete } from "@earendil-works/pi-ai";\n', "utf8");
		writePkgFile(root, "package.json", '{"name":"pi-web-access","version":"0.0.0"}', "utf8");
		writePkgFile(
			root,
			"node_modules/@mozilla/readability/package.json",
			'{"name":"@mozilla/readability","main":"index.js"}',
			"utf8",
		);
		writePkgFile(root, "node_modules/@mozilla/readability/index.js", "module.exports={};", "utf8");
		writePkgFile(root, "node_modules/@mozilla/readability/Readability.js", "module.exports = {};", "utf8");

		// Should not throw and should leave everything intact.
		applyCompatFixes(root);
		assert.equal(readabilityIntact(root), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// --- runSelfHeal (injectable resolver) ---

test("runSelfHeal applies fixes when the resolver returns a root", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		await runSelfHeal(() => root);
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai";\n',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runSelfHeal is a no-op when the resolver returns null", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		await runSelfHeal(() => null);
		// nothing patched
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runSelfHeal swallows a throwing resolver (never breaks loading)", async () => {
	const root = makePkg();
	try {
		writeFileSync(
			path.join(root, "index.ts"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
			"utf8",
		);
		await assert.doesNotReject(async () =>
			runSelfHeal(() => {
				throw new Error("boom");
			}),
		);
		// untouched because resolver threw before patching
		assert.equal(
			readFileSync(path.join(root, "index.ts"), "utf8"),
			'import { complete } from "@earendil-works/pi-ai/compat";\n',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
