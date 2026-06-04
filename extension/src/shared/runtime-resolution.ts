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
  cachedPath?: string;
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

const GLOBAL_SDK_PACKAGE_PATHS = [
  ['@earendil-works', 'pi-coding-agent'],
  ['@mariozechner', 'pi-coding-agent'],
] as const;

function isLegacyGlobalSdkPath(sdkPath: string): boolean {
  const parts = sdkPath.split(/[\\/]+/);
  return parts.at(-2) === '@mariozechner' && parts.at(-1) === 'pi-coding-agent';
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
    'Could not find a standalone Node.js runtime. Set pie.nodePath, PI_NODE_PATH, or add node to PATH.',
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

  if (
    options.cachedPath &&
    !isLegacyGlobalSdkPath(options.cachedPath) &&
    isValidSdkPath(options.cachedPath, exists)
  ) {
    return options.cachedPath;
  }

  const npmRoot = await options.exec('npm', ['root', '-g']);
  if (npmRoot.exitCode !== 0) {
    throw new Error(
      `Failed to resolve the global PI SDK install via npm root -g: ${npmRoot.stderr || npmRoot.stdout}`,
    );
  }

  const npmRootPath = npmRoot.stdout.trim();
  for (const packagePath of GLOBAL_SDK_PACKAGE_PATHS) {
    const sdkPath = path.join(npmRootPath, ...packagePath);
    if (isValidSdkPath(sdkPath, exists)) {
      return sdkPath;
    }
  }

  throw new Error(
    'Could not find @earendil-works/pi-coding-agent or @mariozechner/pi-coding-agent in the global npm root. Set pie.sdkPath or PI_SDK_PATH.',
  );
}
