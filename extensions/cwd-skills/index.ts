import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('resources_discover', async (event) => {
    const skillsDir = join(event.cwd, 'skills');

    if (!existsSync(skillsDir)) {
      return {};
    }

    try {
      if (!statSync(skillsDir).isDirectory()) {
        return {};
      }
    } catch {
      return {};
    }

    return {
      skillPaths: [skillsDir],
    };
  });
}
