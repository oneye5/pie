# safeguard

Blocks dangerous agent operations before they execute. Purely programmatic—no LLM calls.

## Behavior

- **Hard blocks** — Instantly denies catastrophically dangerous commands (no prompt)
- **Prompts** — Asks for confirmation on risky-but-sometimes-legitimate operations (blocks if no UI)

## Coverage

### Hard-blocked (never allowed)
- Disk/volume operations: `dd` to block devices, `mkfs`, `fdisk`, `diskpart`, `format`
- System destruction: `rm -rf /`, boot/kernel tampering, registry deletion
- Fork bombs and reverse shells
- Credential exfiltration via network
- Shadow copy/backup destruction

### Prompts for confirmation
- Privilege escalation: `sudo`, `su`, `runas`
- Recursive deletes outside project directory
- System service management
- Firewall/network config changes
- Package removal
- Writing to sensitive paths outside cwd (`.ssh`, `.env`, shell configs)

## API

```typescript
import { isSafe } from './index.js';

isSafe('rm -rf ./build');           // true
isSafe('rm -rf /');                 // false
isSafe('sudo apt update', { cwd }); // false (requires prompt)
```
