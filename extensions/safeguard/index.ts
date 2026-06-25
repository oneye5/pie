/**
 * Safeguard Extension — Blocks dangerous agent operations
 *
 * Purely programmatic (no LLM calls). Intercepts tool_call events and:
 *   - HARD BLOCKS catastrophically dangerous commands (no prompt, instant deny)
 *   - PROMPTS for risky-but-sometimes-legitimate commands (blocks if no UI)
 *
 * Covers: disk/volume ops, fork bombs, system destruction, privilege escalation,
 * raw device writes, registry destruction, credential exfiltration, and more.
 */

import { resolvePathForComparison, isUnderCwd } from "./paths";
import { analyzeRecursiveRm } from "./shell";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Default bash timeout safeguard ──────────────────────────────────────────
// The bash tool has an optional per-call `timeout` (seconds). When the agent
// omits it, a hung command (whole-PC filesystem walk, infinite loop, blocked
// interactive prompt) would hang indefinitely. This default is applied to every
// bash call that does not already specify a positive finite timeout, so genuine
// long-running tasks are unaffected and the per-call override remains
// authoritative for tasks known to need more (set `timeout` explicitly).
//
// Value is grounded in measured genuine-task durations for this repo:
//   - `npm run typecheck`  ~18s
//   - `cd extension && npm run test` ~22s
//   - `npm run build` (extension) ~30s  (longest observed genuine task)
// 600s is 20× that headroom, so no real task trips it, while any *true* hang
// (which is unbounded) is killed. Documented mechanism: extensions.md `tool_call`
// event — "Mutations to `event.input` affect the actual tool execution".
export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;

/** Apply the default timeout to a bash tool input unless the caller already
 *  set a positive finite one. Mutates `input` in place, matching pi's
 *  `tool_call` mutation contract. */
function applyDefaultBashTimeout(input: { command: string; timeout?: number }): void {
	if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0) {
		input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
	}
}

/**
 * Wraps a command-name regex so it only matches at a "command position" —
 * start of string, after newline, or after shell operators (; && || |).
 * Prevents false positives from grep/echo/man mentioning command names.
 */
function cmdPos(pattern: string, flags = ""): RegExp {
	return new RegExp(`(^|\\n|;|&&|\\|\\||\\|)\\s*${pattern}`, flags);
}

// ─── Bash: Hard-Block Patterns ───────────────────────────────────────────────
// These are never acceptable for an agent to run.

const HARD_BLOCK_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Disk/volume/partition operations
	{ pattern: /\bdd\b.+\bof\s*=\s*\/dev\//, reason: "dd writing to block device" },
	{ pattern: /\bdd\b.+\bof\s*=\s*\\\\\.\\/, reason: "dd writing to Windows raw device" },
	{ pattern: /\bmkfs(\.\w+)?\b/, reason: "Filesystem creation (mkfs)" },
	{ pattern: cmdPos("fdisk\\b"), reason: "Partition editing (fdisk)" },
	{ pattern: cmdPos("parted\\b"), reason: "Partition editing (parted)" },
	{ pattern: cmdPos("diskpart\\b", "i"), reason: "Disk partitioning (diskpart)" },
	{ pattern: cmdPos("format\\s+[a-zA-Z]:", "i"), reason: "Volume formatting (Windows format)" },
	{ pattern: cmdPos("wipefs\\b"), reason: "Wiping filesystem signatures" },
	{ pattern: /\bbadblocks\b.*-w/, reason: "Destructive badblocks write test" },
	{ pattern: /\bhdparm\b.*--trim-sector-ranges/, reason: "Destructive hdparm operation" },
	{ pattern: /\bhdparm\b.*--security-erase/, reason: "Disk security erase" },

	// System destruction
	{ pattern: /\brm\s+(-[^\s]*f[^\s]*\s+-[^\s]*r|-[^\s]*r[^\s]*\s+-[^\s]*f|-[^\s]*rf|-[^\s]*fr)\s+\/(\s|$|\*)/, reason: "Recursive force-delete on root (/)" },
	{ pattern: /\brm\s+(-[^\s]*f[^\s]*\s+-[^\s]*r|-[^\s]*r[^\s]*\s+-[^\s]*f|-[^\s]*rf|-[^\s]*fr)\s+\/\*/, reason: "Recursive force-delete on /*" },
	{ pattern: /\brm\s+(-[^\s]*f[^\s]*\s+-[^\s]*r|-[^\s]*r[^\s]*\s+-[^\s]*f|-[^\s]*rf|-[^\s]*fr)\s+~\/?(\s|$)/, reason: "Recursive force-delete on home directory" },
	{ pattern: /\brm\s+(-[^\s]*f[^\s]*\s+-[^\s]*r|-[^\s]*r[^\s]*\s+-[^\s]*f|-[^\s]*rf|-[^\s]*fr)\s+(C:\\|"C:\\).*\\?(\s|$)/i, reason: "Recursive force-delete on Windows system drive" },

	// Fork bombs
	{ pattern: /:\(\)\s*\{[^}]*\|\s*:.*\}/, reason: "Fork bomb" },
	{ pattern: /\bwhile\s+true\s*;\s*do\s*(fork|:|\$0)\b/, reason: "Infinite fork loop" },
	{ pattern: /\bfork\s*\(\s*\)\s*while/, reason: "Fork bomb (alternative syntax)" },

	// Raw block device writes
	{ pattern: />\s*\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z])/, reason: "Redirecting output to block device" },
	{ pattern: /\btee\b.*\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z])/, reason: "Writing to block device via tee" },

	// Boot/kernel tampering
	{ pattern: /\brm\s.*\/boot\//, reason: "Deleting boot files" },
	{ pattern: /\bdd\b.+\bof\s*=\s*\/boot\//, reason: "Overwriting boot files with dd" },
	{ pattern: /\bmkdir\s+-p\s+\/boot\b/, reason: "Modifying /boot structure" },

	// Credential exfiltration via network
	{ pattern: /cat\s+.*\.(ssh|gnupg|aws|env).*\|\s*(curl|wget|nc|ncat)\b/, reason: "Piping credentials to network command" },
	{ pattern: /(curl|wget|nc)\b.*--data.*\.(ssh|pem|key|env)\b/, reason: "Sending credential files over network" },
	{ pattern: /\b(curl|wget)\b.*-[^\s]*d\s+@.*\.(ssh|pem|key|env)\b/, reason: "Uploading credential files" },

	// Windows registry destruction
	{ pattern: /\breg\s+delete\s+HK(LM|CR|CU)/i, reason: "Deleting Windows registry keys" },

	// Nuclear options
	{ pattern: /\b(sgdisk|gdisk)\b.*--zap/, reason: "Zapping partition table" },
	{ pattern: /\bshred\s.*\/dev\//, reason: "Shredding block device" },
	{ pattern: /\bblkdiscard\b/, reason: "Block device discard" },
	{ pattern: /\bnvme\s+format\b/, reason: "NVMe drive format" },
	{ pattern: /\bcryptsetup\s+(erase|luksErase)\b/, reason: "LUKS encryption erase" },

	// Windows: disk/volume destruction (PowerShell & cmd)
	// NOTE: `diskpart` itself is hard-blocked at any command position by the
	// cmdPos("diskpart\b", "i") pattern above, which already covers every form
	// of piping `clean all` into diskpart (e.g. `echo clean all | diskpart`).
	// A previous bare `\bclean\b.*\ball\b` pattern here caused widespread
	// false positives on legitimate build commands (cargo/npm/gradle/make
	// `clean --all`, `clean-all` script names, even `echo "... clean all ..."`)
	// so it was removed — diskpart remains fully covered.
	{ pattern: cmdPos("Format-Volume\\b", "i"), reason: "Formatting volume (PowerShell)" },
	{ pattern: cmdPos("Clear-Disk\\b", "i"), reason: "Clearing disk (PowerShell)" },
	{ pattern: cmdPos("Initialize-Disk\\b", "i"), reason: "Initializing disk (PowerShell)" },
	{ pattern: cmdPos("Remove-Partition\\b", "i"), reason: "Removing partition (PowerShell)" },

	// Windows: system destruction
	{ pattern: /\brd\s+\/s\s+\/q\s+[a-zA-Z]:\\/i, reason: "Recursive delete of drive root (rd /s /q)" },
	{ pattern: /\bdel\s+\/[fF].*\/[sS].*[a-zA-Z]:\\/, reason: "Force-delete across drive (del /f /s)" },
	{ pattern: /\bcipher\s+\/w:\s*[a-zA-Z]:\\/i, reason: "Wiping free space on drive (cipher /w:)" },
	{ pattern: /Remove-Item\s+.*-Recurse.*[a-zA-Z]:\\/i, reason: "PowerShell recursive delete of drive root" },
	{ pattern: /Remove-Item\s+.*[a-zA-Z]:\\.*-Recurse/i, reason: "PowerShell recursive delete of drive root" },

	// Windows: boot/recovery tampering
	{ pattern: cmdPos("bcdedit\\s+\\/delete", "i"), reason: "Deleting boot configuration entry" },
	{ pattern: cmdPos("bcdedit\\s+\\/set.*recoveryenabled.*no", "i"), reason: "Disabling Windows recovery" },
	{ pattern: cmdPos("reagentc\\s+\\/disable", "i"), reason: "Disabling Windows Recovery Environment" },

	// Windows: shadow copies / backup destruction
	{ pattern: /\bvssadmin\b.*\bdelete\s+shadows\b/i, reason: "Deleting Volume Shadow Copies" },
	{ pattern: /\bwmic\b.*\bshadowcopy\b.*\bdelete\b/i, reason: "Deleting shadow copies via WMI" },
	{ pattern: /Get-WmiObject.*Win32_ShadowCopy.*Delete/i, reason: "Deleting shadow copies (PowerShell)" },

	// Windows: security/defender disabling
	{ pattern: /Set-MpPreference\s+.*-DisableRealtimeMonitoring\s+\$?true/i, reason: "Disabling Windows Defender real-time protection" },
	{ pattern: /Set-MpPreference\s+.*-DisableIOAVProtection\s+\$?true/i, reason: "Disabling Windows Defender download scanning" },
	{ pattern: cmdPos("Disable-WindowsOptionalFeature.*Windows-Defender", "i"), reason: "Uninstalling Windows Defender" },

	// Windows: credential/certificate destruction
	{ pattern: /\bcertutil\b.*-delstore/i, reason: "Deleting certificates from store" },
	{ pattern: /Remove-Item.*\\Crypto\\RSA/i, reason: "Deleting cryptographic keys" },

	// Obfuscated/indirect execution of dangerous payloads
	{ pattern: /\bbase64\b.*\|\s*(bash|sh|zsh|cmd)\b/, reason: "Base64-decoded content piped to shell" },
	{ pattern: /\beval\b.*\$\(/, reason: "eval with command substitution" },
	{ pattern: /\bcurl\b.*\|\s*(bash|sh|zsh|python|node)\b/, reason: "Piping remote script to interpreter" },
	{ pattern: /\bwget\b.*-O\s*-.*\|\s*(bash|sh|zsh|python|node)\b/, reason: "Piping remote script to interpreter" },

	// Reverse shells
	{ pattern: /\bbash\s+-i\s+>&?\s*\/dev\/(tcp|udp)\//, reason: "Reverse shell via /dev/tcp" },
	{ pattern: /\bnc(at)?\b.*-[^\ ]*e\s*\/?(bin\/)?sh/, reason: "Reverse shell via netcat" },
	{ pattern: /\bmkfifo\b.*\/tmp\/.*\bnc\b/, reason: "Named pipe reverse shell" },
];

// ─── Bash: Prompt Patterns ───────────────────────────────────────────────────
// Risky but sometimes legitimate. Ask user, or block if no UI.

const PROMPT_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Privilege escalation
	{ pattern: cmdPos("sudo\\b"), reason: "Privilege escalation (sudo)" },
	{ pattern: cmdPos("su\\s+-?\\s*\\w*\\s*$"), reason: "Switching user (su)" },
	{ pattern: cmdPos("doas\\b"), reason: "Privilege escalation (doas)" },
	{ pattern: cmdPos("runas\\b", "i"), reason: "Privilege escalation (runas)" },

	// Recursive delete outside project (handled contextually below)
	// Broad permission changes on system paths
	{ pattern: /\bchmod\s+777\b/, reason: "Setting world-writable permissions (chmod 777)" },
	{ pattern: /\bchmod\s+-R\b.*\/(etc|usr|var|boot)\b/, reason: "Recursive permission change on system path" },
	{ pattern: /\bchown\s+-R\b.*\/(etc|usr|var|boot)\b/, reason: "Recursive ownership change on system path" },

	// Service management
	{ pattern: /\bsystemctl\s+(stop|disable|mask)\b/, reason: "Stopping/disabling a system service" },
	{ pattern: /\bservice\s+\S+\s+stop\b/, reason: "Stopping a service" },
	{ pattern: /\bnet\s+stop\b/i, reason: "Stopping a Windows service" },
	{ pattern: /\bsc\s+delete\b/i, reason: "Deleting a Windows service (sc delete)" },
	{ pattern: /\bsc\s+config\b.*\bstart\s*=\s*disabled/i, reason: "Disabling a Windows service (sc config)" },
	{ pattern: /Stop-Service.*-Force/i, reason: "Force-stopping a Windows service" },
	{ pattern: /Remove-Service\b/i, reason: "Removing a Windows service (PowerShell)" },

	// Windows: user/group manipulation
	{ pattern: /\bnet\s+user\b.*\/delete/i, reason: "Deleting a Windows user account" },
	{ pattern: /\bnet\s+localgroup\s+administrators\b.*\/add/i, reason: "Adding user to Administrators group" },
	{ pattern: /Remove-LocalUser\b/i, reason: "Removing local user (PowerShell)" },
	{ pattern: /Add-LocalGroupMember.*Administrators/i, reason: "Adding user to Administrators (PowerShell)" },

	// Windows: BitLocker
	{ pattern: /Disable-BitLocker\b/i, reason: "Disabling BitLocker encryption" },
	{ pattern: /manage-bde\s+.*-(off|wipe)/i, reason: "Disabling/wiping BitLocker" },

	// Windows: firewall (PowerShell)
	{ pattern: /Set-NetFirewallProfile.*-Enabled\s+False/i, reason: "Disabling Windows Firewall" },
	{ pattern: /Disable-NetFirewallRule\b/i, reason: "Disabling firewall rules" },

	// Windows: execution policy
	{ pattern: /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i, reason: "Setting PowerShell execution policy to unrestricted" },

	// Windows: taking ownership of system files
	{ pattern: /\btakeown\b.*\/f.*[a-zA-Z]:\\Windows/i, reason: "Taking ownership of Windows system files" },
	{ pattern: /\bicacls\b.*[a-zA-Z]:\\Windows.*\/grant/i, reason: "Granting permissions on Windows system files" },

	// Network config
	{ pattern: /\biptables\b.*(-A|-D|-I|-F)\b/, reason: "Modifying firewall rules (iptables)" },
	{ pattern: /\bufw\s+(deny|delete|reset)\b/, reason: "Modifying firewall (ufw)" },
	{ pattern: /\bnetsh\b.*\b(add|delete|set)\b/i, reason: "Modifying network config (netsh)" },

	// Package removal
	{ pattern: /\bapt(-get)?\s+(remove|purge)\b/, reason: "Removing system packages (apt)" },
	{ pattern: /\bdnf\s+remove\b/, reason: "Removing system packages (dnf)" },
	{ pattern: /\bpacman\s+-R/, reason: "Removing system packages (pacman)" },
	{ pattern: /\bchoco\s+uninstall\b/i, reason: "Removing packages (choco)" },
	{ pattern: /\bbrew\s+uninstall\b/, reason: "Removing packages (brew)" },
	{ pattern: /\bwinget\s+uninstall\b/i, reason: "Removing packages (winget)" },

	// Opaque interpreter execution (can't statically analyze what runs)
	{ pattern: /\bpython3?\s+-c\s+['"].*\b(os\.system|subprocess|shutil\.rmtree|open\(['"][/~])/, reason: "Python one-liner with system access" },
	{ pattern: /\bnode\s+-e\s+['"].*\b(execSync|spawnSync|child_process|fs\.rm)/, reason: "Node one-liner with system access" },
];

// ─── Path: Hard-Block (write/edit) ──────────────────────────────────────────

const HARD_BLOCK_PATHS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /^\/boot\//, reason: "Writing to /boot" },
	{ pattern: /^\/dev\//, reason: "Writing to /dev" },
	{ pattern: /^\/proc\//, reason: "Writing to /proc" },
	{ pattern: /^\/sys\//, reason: "Writing to /sys" },
	{ pattern: /^\/etc\/passwd$/, reason: "Writing to /etc/passwd" },
	{ pattern: /^\/etc\/shadow$/, reason: "Writing to /etc/shadow" },
	{ pattern: /^\/etc\/sudoers$/, reason: "Writing to /etc/sudoers" },
	{ pattern: /^c:\/windows\/system32\//, reason: "Writing to Windows System32" },
	{ pattern: /^c:\/windows\/syswow64\//, reason: "Writing to Windows SysWOW64" },
	{ pattern: /^\\\\\.\\physicaldrive/, reason: "Writing to raw physical drive" },
	{ pattern: /^\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z])/, reason: "Writing to block device" },
];

// ─── Path: Prompt (write/edit) ───────────────────────────────────────────────

const PROMPT_PATHS: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\/(\.ssh|\.gnupg|\.aws)\// , reason: "Writing to sensitive credentials directory" },
	{ pattern: /\/\.gitconfig$/, reason: "Writing to global git config" },
	{ pattern: /\/\.bashrc$/, reason: "Writing to .bashrc" },
	{ pattern: /\/\.zshrc$/, reason: "Writing to .zshrc" },
	{ pattern: /\/\.profile$/, reason: "Writing to .profile" },
	{ pattern: /\/\.npmrc$/, reason: "Writing to .npmrc (may contain auth tokens)" },
	{ pattern: /\/\.docker\/config\.json$/, reason: "Writing to Docker config (may contain auth)" },
];

// ─── Public Safety Checks ───────────────────────────────────────────────────

export function isSafe(command: string, options: { cwd?: string } = {}): boolean {
	const cwd = options.cwd ?? process.cwd();
	return analyzeBash(command, cwd).action === "allow";
}

function analyzeBash(command: string, cwd: string): { action: "allow" | "block" | "prompt"; reason?: string } {
	// Check hard blocks first.
	for (const { pattern, reason } of HARD_BLOCK_PATTERNS) {
		if (pattern.test(command)) {
			return { action: "block", reason };
		}
	}

	const rmAnalysis = analyzeRecursiveRm(command, cwd);
	if (rmAnalysis && rmAnalysis.action !== "allow") {
		return rmAnalysis;
	}

	// Check prompt patterns.
	for (const { pattern, reason } of PROMPT_PATTERNS) {
		if (pattern.test(command)) {
			return { action: "prompt", reason };
		}
	}

	return rmAnalysis ?? { action: "allow" };
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			// Apply the hang safeguard before any safety analysis so even a
			// command that is ultimately allowed (or user-approved) is bounded.
			applyDefaultBashTimeout(event.input as { command: string; timeout?: number });
			return handleBash(event.input.command as string, ctx);
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			return handleWritePath(event.input.path as string, ctx);
		}

		return undefined;
	});
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function handleBash(command: string, ctx: ExtensionContext) {
	const safety = analyzeBash(command, ctx.cwd);

	if (safety.action === "block") {
		notify(ctx, `🛑 BLOCKED: ${safety.reason}`);
		return { block: true, reason: `Safeguard: ${safety.reason}` };
	}

	if (safety.action === "prompt") {
		return promptOrBlock(ctx, command, safety.reason ?? "Risky command");
	}

	return undefined;
}

function handleWritePath(targetPath: string, ctx: ExtensionContext) {
	const normalized = resolvePathForComparison(targetPath, ctx.cwd);

	// Hard blocks.
	for (const { pattern, reason } of HARD_BLOCK_PATHS) {
		if (pattern.test(normalized)) {
			notify(ctx, `🛑 BLOCKED: ${reason}`);
			return { block: true, reason: `Safeguard: ${reason}` };
		}
	}

	// Prompt paths (only outside cwd after normalization / traversal resolution).
	if (!isUnderCwd(targetPath, ctx.cwd)) {
		for (const { pattern, reason } of PROMPT_PATHS) {
			if (pattern.test(normalized)) {
				return promptOrBlock(ctx, targetPath, reason);
			}
		}

		// .env files outside project, including .envrc.
		if (/\/\.env(?:$|\.[^/]+$|rc$)/.test(normalized)) {
			return promptOrBlock(ctx, targetPath, "Writing to .env file outside project");
		}
	}

	return undefined;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

async function promptOrBlock(
	ctx: ExtensionContext,
	target: string,
	reason: string,
): Promise<{ block: true; reason: string } | undefined> {
	if (!ctx.hasUI) {
		return { block: true, reason: `Safeguard: ${reason} (no UI for confirmation)` };
	}

	const truncated = target.length > 120 ? target.slice(0, 120) + "…" : target;

	let allowed: boolean;
	try {
		// Await user input indefinitely. A confirmation prompt must NOT time out —
		// if the user is slow to respond, timing out would silently deny the
		// command and force the agent down a different (possibly worse) path.
		// We only reach this branch when a UI is present, so the prompt is
		// guaranteed to be answerable; we wait as long as the user needs.
		allowed = await ctx.ui.confirm(`⚠️ Safeguard: ${reason}`, `Allow?\n\n  ${truncated}`);
	} catch {
		return { block: true, reason: `Safeguard: ${reason} (confirmation failed)` };
	}

	if (!allowed) {
		return { block: true, reason: `Safeguard: ${reason} (denied by user)` };
	}

	return undefined;
}

function notify(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "warning");
	}
}
