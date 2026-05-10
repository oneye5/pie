export function parseFileUriList(value: string): string[] {
  if (!value.trim()) return [];

  const paths: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const path = fileUriToFsPath(line);
    if (path) {
      paths.push(path);
    }
  }

  return [...new Set(paths)];
}

function fileUriToFsPath(rawValue: string): string | null {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    return null;
  }

  if (url.protocol !== 'file:') {
    return null;
  }

  const host = decodeURIComponent(url.hostname);
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }

  if (host && host !== 'localhost') {
    return `\\\\${host}${pathname.replace(/\//g, '\\')}`;
  }

  return pathname;
}
