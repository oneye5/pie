import * as path from 'node:path';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;

interface CommonOptions {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (filePath: string) => boolean;
}

export interface ResolveNodePathOptions extends CommonOptions {
  configuredPath?: string;
}

export interface ResolveSdkPathOptions extends CommonOptions {
  configuredPath?: string;
  exec: CommandExecutor;
}

const defaultExists = (filePath: string): boolean => {
  try {
    return require('node:fs').existsSync(filePath);
  } catch {
    return false;
  }
};

function ensureExistingPath(
  label: string,
  filePath: string | undefined,
  exists: (value: string) => boolean,
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  if (!exists(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }

  return filePath;
}

function splitPathEnv(envPath: string | undefined): string[] {
  if (!envPath) {
    return [];
  }

  return envPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findOnPath(
  executableName: string,
  envPath: string | undefined,
  platform: NodeJS.Platform,
  exists: (filePath: string) => boolean,
): string | undefined {
  const names =
    platform === 'win32'
      ? [
          executableName,
          `${executableName}.exe`,
          `${executableName}.cmd`,
          `${executableName}.bat`,
        ]
      : [executableName];

  for (const dir of splitPathEnv(envPath)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function isValidSdkPath(sdkPath: string, exists: (filePath: string) => boolean): boolean {
  return exists(path.join(sdkPath, 'package.json')) && exists(path.join(sdkPath, 'dist', 'index.js'));
}

export function resolveNodePath(options: ResolveNodePathOptions): string {
  const exists = options.exists ?? defaultExists;
  const platform = options.platform ?? process.platform;

  const configuredPath = ensureExistingPath(
    'Configured PI nodePath',
    options.configuredPath,
    exists,
  );
  if (configuredPath) {
    return configuredPath;
  }

  const envPath = ensureExistingPath('PI_NODE_PATH', options.env.PI_NODE_PATH, exists);
  if (envPath) {
    return envPath;
  }

  const fromPath = findOnPath('node', options.env.PATH, platform, exists);
  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    'Could not find a standalone Node.js runtime. Set piAssistant.nodePath, PI_NODE_PATH, or add node to PATH.',
  );
}

export async function resolveSdkPath(options: ResolveSdkPathOptions): Promise<string> {
  const exists = options.exists ?? defaultExists;

  const configuredPath = options.configuredPath;
  if (configuredPath) {
    if (!isValidSdkPath(configuredPath, exists)) {
      throw new Error(`Configured PI sdkPath is not a valid SDK install: ${configuredPath}`);
    }
    return configuredPath;
  }

  const envPath = options.env.PI_SDK_PATH;
  if (envPath) {
    if (!isValidSdkPath(envPath, exists)) {
      throw new Error(`PI_SDK_PATH is not a valid SDK install: ${envPath}`);
    }
    return envPath;
  }

  const npmRoot = await options.exec('npm', ['root', '-g']);
  if (npmRoot.exitCode !== 0) {
    throw new Error(
      `Failed to resolve the global PI SDK install via npm root -g: ${npmRoot.stderr || npmRoot.stdout}`,
    );
  }

  const sdkPath = path.join(npmRoot.stdout.trim(), '@mariozechner', 'pi-coding-agent');
  if (!isValidSdkPath(sdkPath, exists)) {
    throw new Error(
      'Could not find @mariozechner/pi-coding-agent in the global npm root. Set piAssistant.sdkPath or PI_SDK_PATH.',
    );
  }

  return sdkPath;
}
