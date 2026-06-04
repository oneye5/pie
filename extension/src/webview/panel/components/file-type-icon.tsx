/** @jsxRuntime automatic */
/** @jsxImportSource preact */

interface FileTypeIconProps {
  path: string;
  className?: string;
}

const ICON_SIZE = 16;

/* ── SVG helpers ─────────────────────────────────────────────────────────── */

function svgWrapper(children: preact.VNode, viewBox = '0 0 16 16', bg?: string) {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox={viewBox}
      fill="none"
      aria-hidden="true"
    >
      {bg && <rect width="16" height="16" rx="2" fill={bg} />}
      {children}
    </svg>
  );
}

/* ── Language icons (simplified brand logos) ─────────────────────────────── */

const ICONS: Record<string, (props: { className?: string }) => preact.VNode> = {
  ts: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#3178C6" />
        <text x="8" y="12" textAnchor="middle" fill="white" fontSize="9" fontWeight="700" fontFamily="ui-monospace, monospace">TS</text>
      </g>
    ),
  tsx: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#3178C6" />
        <text x="8" y="12" textAnchor="middle" fill="white" fontSize="7.5" fontWeight="700" fontFamily="ui-monospace, monospace">TSX</text>
      </g>
    ),
  js: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#F7DF1E" />
        <text x="8" y="12" textAnchor="middle" fill="#323330" fontSize="9" fontWeight="700" fontFamily="ui-monospace, monospace">JS</text>
      </g>
    ),
  jsx: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#61DAFB" />
        <text x="8" y="12" textAnchor="middle" fill="#20232a" fontSize="7.5" fontWeight="700" fontFamily="ui-monospace, monospace">JSX</text>
      </g>
    ),
  py: () =>
    svgWrapper(
      <g>
        <path d="M8 1c-2 0-3.5.5-3.5 2v2h3.5v.5H3.5C1.5 5.5 1 7 1 9s.5 3.5 2.5 3.5h1V10c0-1.5 1-2.5 2.5-2.5h3.5c1 0 2-.5 2-2V3c0-2-1.5-3-3.5-3H8zM6.5 2.5c.5 0 1 .5 1 1s-.5 1-1 1-1-.5-1-1 .5-1 1-1z" fill="#3776AB" />
        <path d="M8 15c2 0 3.5-.5 3.5-2v-2H8v-.5h4.5c2 0 2.5-1.5 2.5-3.5s-.5-3.5-2.5-3.5h-1V6c0 1.5-1 2.5-2.5 2.5H5.5c-1 0-2 .5-2 2v2c0 2 1.5 3 3.5 3H8zm1.5-1c-.5 0-1-.5-1-1s.5-1 1-1 1 .5 1 1-.5 1-1 1z" fill="#FFD43B" />
      </g>
    ),
  html: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#E34F26" />
        <path d="M4 4l1 8 3 1 3-1 1-8H4zm2.5 2h3l-.2 1h-2.6l.2 1h2.2l-.3 2-1.5.5-1.5-.5-.1-.5h-1l.2 1 2.4.8 2.4-.8.5-3H6.5z" fill="white" />
      </g>
    ),
  htm: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#E34F26" />
        <path d="M4 4l1 8 3 1 3-1 1-8H4zm2.5 2h3l-.2 1h-2.6l.2 1h2.2l-.3 2-1.5.5-1.5-.5-.1-.5h-1l.2 1 2.4.8 2.4-.8.5-3H6.5z" fill="white" />
      </g>
    ),
  css: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#1572B6" />
        <path d="M4 4l1 8 3 1 3-1 1-8H4zm2.5 2h3l-.2 1h-2.6l.2 1h2.2l-.3 2-1.5.5-1.5-.5-.1-.5h-1l.2 1 2.4.8 2.4-.8.5-3H6.5z" fill="white" />
      </g>
    ),
  scss: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#CC6699" />
        <path d="M4 4l1 8 3 1 3-1 1-8H4zm2.5 2h3l-.2 1h-2.6l.2 1h2.2l-.3 2-1.5.5-1.5-.5-.1-.5h-1l.2 1 2.4.8 2.4-.8.5-3H6.5z" fill="white" />
      </g>
    ),
  sass: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#CC6699" />
        <path d="M4 4l1 8 3 1 3-1 1-8H4zm2.5 2h3l-.2 1h-2.6l.2 1h2.2l-.3 2-1.5.5-1.5-.5-.1-.5h-1l.2 1 2.4.8 2.4-.8.5-3H6.5z" fill="white" />
      </g>
    ),
  json: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#A0A0A0" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace">{'{}'}</text>
      </g>
    ),
  xml: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#0060AC" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="9" fontWeight="700" fontFamily="ui-monospace, monospace">{'<>'}</text>
      </g>
    ),
  yaml: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#CB171E" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">YML</text>
      </g>
    ),
  yml: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#CB171E" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">YML</text>
      </g>
    ),
  md: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#083FA1" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="9" fontWeight="700" fontFamily="ui-monospace, monospace">Md</text>
      </g>
    ),
  mdx: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#1B1F24" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7" fontWeight="700" fontFamily="ui-monospace, monospace">MDX</text>
      </g>
    ),
  rs: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#000000" />
        <text x="8" y="11.5" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">RUST</text>
      </g>
    ),
  go: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#00ADD8" />
        <text x="8" y="11.5" textAnchor="middle" fill="white" fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace">Go</text>
      </g>
    ),
  java: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#E76F00" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7.5" fontWeight="700" fontFamily="ui-monospace, monospace">JAVA</text>
      </g>
    ),
  cpp: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#00599C" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">C++</text>
      </g>
    ),
  c: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#555555" />
        <text x="8" y="11.5" textAnchor="middle" fill="white" fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace">C</text>
      </g>
    ),
  cs: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#178600" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">C#</text>
      </g>
    ),
  rb: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#CC342D" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">RB</text>
      </g>
    ),
  php: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#4F5D95" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">PHP</text>
      </g>
    ),
  swift: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#F05138" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="6.5" fontWeight="700" fontFamily="ui-monospace, monospace">SWIFT</text>
      </g>
    ),
  kt: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#A97BFF" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">KT</text>
      </g>
    ),
  sql: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#336791" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7.5" fontWeight="700" fontFamily="ui-monospace, monospace">SQL</text>
      </g>
    ),
  sh: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#89E051" />
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">SH</text>
      </g>
    ),
  bash: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#89E051" />
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="6" fontWeight="700" fontFamily="ui-monospace, monospace">BASH</text>
      </g>
    ),
  zsh: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#89E051" />
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="7" fontWeight="700" fontFamily="ui-monospace, monospace">ZSH</text>
      </g>
    ),
  fish: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#89E051" />
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="6.5" fontWeight="700" fontFamily="ui-monospace, monospace">FISH</text>
      </g>
    ),
  dockerfile: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#2496ED" />
        <path d="M3 7h1v1H3V7zm2 0h1v1H5V7zm2 0h1v1H7V7zm2 0h1v1H9V7zm2 0h1v1h-1V7zM3 9h1v1H3V9zm2 0h1v1H5V9zm2 0h1v1H7V9zm2 0h1v1H9V9zm2 0h1v1h-1V9zM3 11h1v1H3v-1zm2 0h1v1H5v-1zm2 0h1v1H7v-1zm2 0h1v1H9v-1zm2 0h1v1h-1v-1zM2 6h12v8a1 1 0 01-1 1H3a1 1 0 01-1-1V6z" fill="white" />
        <path d="M11 4c0-1 1-1 1-1s1 0 1 1v1h-2V4z" fill="white" />
      </g>
    ),
  vue: () =>
    svgWrapper(
      <g>
        <polygon points="8,1 1,14 4,14 8,7 12,14 15,14" fill="#41B883" />
        <polygon points="8,4 5,10 7,10 8,8 9,10 11,10" fill="#34495E" />
      </g>
    ),
  svelte: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#FF3E00" />
        <path d="M10.5 4c1.5 0 2.5 1 2.5 2.5 0 1-.5 1.5-1 2l-4 3c-.5.5-1 1-1 1.5 0 .5.5 1 1 1 .5 0 1-.5 1.5-1l1.5 1c-1 1-2 1.5-3 1.5-1.5 0-2.5-1-2.5-2.5 0-1 .5-1.5 1-2l4-3c.5-.5 1-1 1-1.5 0-.5-.5-1-1-1-.5 0-1 .5-1.5 1l-1.5-1c1-1 2-1.5 3-1.5z" fill="white" />
      </g>
    ),
  react: () =>
    svgWrapper(
      <g>
        <circle cx="8" cy="8" r="1.5" fill="#61DAFB" />
        <ellipse cx="8" cy="8" rx="6" ry="2.5" stroke="#61DAFB" strokeWidth=".8" fill="none" />
        <ellipse cx="8" cy="8" rx="6" ry="2.5" stroke="#61DAFB" strokeWidth=".8" fill="none" transform="rotate(60 8 8)" />
        <ellipse cx="8" cy="8" rx="6" ry="2.5" stroke="#61DAFB" strokeWidth=".8" fill="none" transform="rotate(120 8 8)" />
      </g>
    ),
  astro: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#FF5D01" />
        <path d="M8 2l3.5 10h-2L8.8 8H7.2L6.5 12h-2L8 2z" fill="white" />
      </g>
    ),
  dart: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#00B4AB" />
        <path d="M4 12l8-8v4l-4 4H4z" fill="white" />
        <path d="M12 4l-2 2v4l2-2V4z" fill="#C4C4C4" />
      </g>
    ),
  lua: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#000080" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7" fontWeight="700" fontFamily="ui-monospace, monospace">LUA</text>
      </g>
    ),
  toml: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#9C4121" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="6.5" fontWeight="700" fontFamily="ui-monospace, monospace">TOML</text>
      </g>
    ),
  graphql: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#E10098" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="5.5" fontWeight="700" fontFamily="ui-monospace, monospace">GQL</text>
      </g>
    ),
  gql: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#E10098" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="5.5" fontWeight="700" fontFamily="ui-monospace, monospace">GQL</text>
      </g>
    ),
  prisma: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#0C344B" />
        <polygon points="8,2 14,8 8,14 2,8" fill="#2D3748" />
        <polygon points="8,4 12,8 8,12 4,8" fill="white" />
      </g>
    ),
  less: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#1D365D" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7" fontWeight="700" fontFamily="ui-monospace, monospace">LESS</text>
      </g>
    ),
  styl: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#B3D107" />
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="6" fontWeight="700" fontFamily="ui-monospace, monospace">STYL</text>
      </g>
    ),
  lock: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#6B7280" />
        <path d="M8 3a2 2 0 012 2v1H6V5a2 2 0 012-2zm-3 3h6v5a1 1 0 01-1 1H6a1 1 0 01-1-1V6z" fill="white" />
        <circle cx="8" cy="8.5" r=".8" fill="#6B7280" />
      </g>
    ),
  gitignore: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#F05032" />
        <path d="M8 2a3 3 0 00-3 3v1H4v6h8V6h-1V5a3 3 0 00-3-3zm0 1a2 2 0 012 2v1H6V5a2 2 0 012-2z" fill="white" />
      </g>
    ),
  env: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#ECD53F" />
        <text x="8" y="11" textAnchor="middle" fill="#1a1a1a" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">ENV</text>
      </g>
    ),
  npm: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#CB3837" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="8" fontWeight="700" fontFamily="ui-monospace, monospace">NPM</text>
      </g>
    ),
  license: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#6866FB" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7.5" fontWeight="700" fontFamily="ui-monospace, monospace">LIC</text>
      </g>
    ),
  readme: () =>
    svgWrapper(
      <g>
        <rect width="16" height="16" rx="2" fill="#083FA1" />
        <text x="8" y="11" textAnchor="middle" fill="white" fontSize="5" fontWeight="700" fontFamily="ui-monospace, monospace">README</text>
      </g>
    ),
};

/* ── Known filenames without extension ───────────────────────────────────── */

const KNOWN_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'sh',
  rakefile: 'rb',
  gemfile: 'rb',
  'cargo.toml': 'rs',
  vagrantfile: 'sh',
  jenkinsfile: 'sh',
  justfile: 'sh',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.gitmodules': 'gitignore',
  '.env': 'env',
  '.editorconfig': 'ini',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  readme: 'readme',
  'readme.md': 'readme',
  'readme.txt': 'readme',
  changelog: 'readme',
  'changelog.md': 'readme',
  'package.json': 'npm',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'composer.lock': 'lock',
  'cargo.lock': 'lock',
  'gemfile.lock': 'lock',
  'pipfile.lock': 'lock',
};

/* ── Generic fallback icon ─────────────────────────────────────────────────── */

function GenericIcon({ ext }: { ext: string }) {
  return svgWrapper(
    <g>
      <rect width="16" height="16" rx="2" fill="#6B7280" />
      <text x="8" y="11" textAnchor="middle" fill="white" fontSize="7" fontWeight="700" fontFamily="ui-monospace, monospace">
        {ext.slice(0, 3).toUpperCase()}
      </text>
    </g>
  );
}

/* ── Resolution ──────────────────────────────────────────────────────────── */

function resolveIconKey(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';

  // Direct extension match
  if (ICONS[ext]) return ext;

  // Known filename match
  const nameLower = base.toLowerCase();
  if (KNOWN_NAMES[nameLower]) return KNOWN_NAMES[nameLower];

  return ext;
}

/* ── Public component ────────────────────────────────────────────────────── */

export function FileTypeIcon({ path, className = '' }: FileTypeIconProps) {
  const key = resolveIconKey(path);
  const Icon = ICONS[key];

  if (Icon) {
    return <span class={`file-type-icon brand ${className}`}><Icon /></span>;
  }

  // Fallback to generic badge with extension letters
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : base.slice(0, 2);
  return (
    <span class={`file-type-icon brand ${className}`}>
      <GenericIcon ext={ext} />
    </span>
  );
}
