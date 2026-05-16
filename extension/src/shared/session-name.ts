export const NEW_SESSION_NAME = 'New Session';
const MAX_SESSION_NAME_LENGTH = 40;

export interface DerivedSessionName {
  name: string;
  isPlaceholder: boolean;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'for',
  'from', 'has', 'have', 'had', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'so',
  'the', 'to', 'too', 'was', 'were', 'with', 'would', 'could', 'should', 'may',
  'might', 'can', 'this', 'that', 'there', 'their', 'they', 'them', 'these',
  'those', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his',
  'she', 'her', 'do', 'does', 'did', 'done', 'will', 'shall', 'am', 'if', 'than',
  'then', 'when', 'where', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'also', 'cannot', 'get', 'got', 'go', 'just',
  'like', 'now', 'here', 'up', 'out', 'down', 'off', 'over', 'under', 'again',
  'once', 'during', 'before', 'after', 'above', 'below', 'between', 'into',
  'through', 'while', 'about', 'against', 'around', 'among', 'within', 'without',
  'another', 'much', 'many', 'very', 'really', 'actually', 'basically',
  'essentially', 'literally', 'definitely', 'probably', 'maybe', 'perhaps',
  'please', 'help', 'with', 'need', 'want', 'look', 'looking', 'trying', 'try',
  'see', 'think', 'know', 'let', 'lets', "let's", 'give', 'make', 'sure', 'way', 'mind',
  'use', 'using', 'used', 'via', 'onto', 'upon', 'until', 'unless', 'though',
  'although', 'even', 'because', 'since', 'yet', 'still', 'already', 'ever',
  'never', 'always', 'often', 'sometimes', 'usually', 'generally', 'typically',
  'finally', 'eventually', 'initially', 'recently', 'currently', 'today',
  'everywhere', 'anywhere', 'somewhere', 'nowhere', 'else', 'instead', 'rather',
  'quite', 'almost', 'nearly', 'hardly', 'barely', 'simply', 'merely', 'soon',
  'later', 'afterwards', 'meanwhile', 'otherwise', 'however', 'therefore', 'thus',
  'hence', 'accordingly', 'consequently', 'given', 'ok', 'okay', 'yes', 'no',
  'yeah', 'nah', 'yep', 'nope', 'so', 'well', 'um', 'uh', 'hmm', 'oh', 'ah',
]);

const ACTION_WORDS = new Set([
  'refactor', 'fix', 'add', 'implement', 'create', 'build', 'debug', 'test',
  'update', 'remove', 'delete', 'change', 'rename', 'optimize', 'improve',
  'migrate', 'setup', 'configure', 'deploy', 'integrate', 'replace', 'extract',
  'introduce', 'support', 'enable', 'disable', 'generate', 'write', 'draft',
  'review', 'analyze', 'investigate', 'solve', 'resolve', 'clean', 'upgrade',
  'revert', 'merge', 'split', 'move', 'copy', 'handle', 'parse', 'validate',
  'format', 'sort', 'filter', 'search', 'find', 'get', 'set', 'read', 'load',
  'save', 'send', 'receive', 'process', 'render', 'display', 'show', 'hide',
  'toggle', 'run', 'execute', 'stop', 'start', 'restart', 'check', 'verify',
  'assert', 'mock', 'log', 'monitor', 'watch', 'listen', 'emit', 'notify',
  'warn', 'throw', 'catch', 'cache', 'store', 'push', 'pull', 'fetch', 'clone',
  'checkout', 'commit', 'install', 'uninstall', 'publish', 'sync', 'backup',
  'restore', 'reset', 'undo', 'retry', 'abort', 'skip', 'ignore', 'exclude',
  'include', 'organize', 'design', 'style', 'theme', 'animate', 'query',
  'request', 'response', 'submit', 'upload', 'download', 'attach', 'connect',
  'disconnect', 'link', 'unlink', 'bind', 'unbind', 'wrap', 'unwrap', 'encode',
  'decode', 'encrypt', 'decrypt', 'compress', 'decompress', 'convert',
  'transform', 'map', 'reduce', 'group', 'batch', 'queue', 'schedule',
  'make', 'crash', 'crashes', 'fail', 'fails', 'failed', 'failing', 'break', 'breaks', 'broken',
  'rebuild', 'rewrite', 'rework', 'adjust', 'tweak', 'patch', 'correct',
  'repair', 'remedy', 'mend', 'cover', 'fill', 'clear', 'free', 'release',
  'drop', 'raise', 'lift', 'lower', 'elevate', 'trace', 'profile', 'benchmark',
  'diagram', 'chart', 'graph', 'model', 'plan', 'script', 'automate',
  'containerize', 'dockerize', 'vectorize', 'serialize', 'deserialize',
]);

const LEADING_JUNK_RE =
  /^(?:how\s+(?:do|can|would|should|to|do\s+i|can\s+i)\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+(?:mind\s+)?|please\s+|help\s+(?:me\s+)?(?:with\s+)?|i\s+(?:want|need|would\s+like)\s+to\s+|let['']?s\s+|is\s+there\s+(?:a|an)?\s*(?:way|method|approach|solution)?\s*(?:to|for|of)?\s*)/i;

/**
 * Title-case a word while preserving acronyms and camelCase identifiers.
 * - All-uppercase short words (≤5 chars) are likely acronyms: JWT, CSS, E2E → kept as-is.
 * - Words with internal mixed casing (camelCase / PascalCase) keep their shape: OAuth2, getUserById.
 * - Everything else gets standard title-case: authentication → Authentication.
 */
function titleCaseWord(w: string): string {
  if (w.length === 0) return w;
  // All-uppercase short words are likely acronyms (JWT, API, CSS, E2E, REST).
  if (w === w.toUpperCase() && w.length <= 5) return w;
  // Words with internal mixed casing (camelCase / PascalCase) preserve their shape.
  const tail = w.slice(1);
  if (/[a-z]/.test(tail) && /[A-Z]/.test(tail)) {
    return w.charAt(0).toUpperCase() + tail;
  }
  return w.charAt(0).toUpperCase() + tail.toLowerCase();
}

function generateSmartName(text: string): string {
  let cleaned = text.replace(LEADING_JUNK_RE, '');

  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/\S+/g, ' ');
  cleaned = cleaned.replace(/[^\p{L}\p{N}\s'-.]/gu, ' ').replace(/\s+/g, ' ').trim();

  const words = cleaned.split(' ').filter((w) => w.length > 0);
  if (words.length === 0) {
    return '';
  }

  let chosen: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const lower = words[i].toLowerCase();
    if (ACTION_WORDS.has(lower)) {
      chosen.push(words[i]);
      let added = 0;
      for (let j = i + 1; j < words.length && added < 3; j++) {
        if (!STOPWORDS.has(words[j].toLowerCase())) {
          chosen.push(words[j]);
          added++;
        }
      }
      break;
    }
  }

  if (chosen.length === 0) {
    chosen = words
      .filter((w) => !STOPWORDS.has(w.toLowerCase()))
      .slice(0, 4);
  }

  if (chosen.length === 1 && ACTION_WORDS.has(chosen[0].toLowerCase())) {
    const idx = words.findIndex((w) => w.toLowerCase() === chosen[0].toLowerCase());
    if (idx !== -1 && idx + 1 < words.length) {
      chosen.push(words[idx + 1]);
    }
  }

  if (chosen.length === 0) {
    return '';
  }

  const name = chosen
    .map(titleCaseWord)
    .join(' ');

  return name.length > MAX_SESSION_NAME_LENGTH
    ? `${name.slice(0, MAX_SESSION_NAME_LENGTH)}\u2026`
    : name;
}

export function deriveSessionNameFromText(text: string | null | undefined): DerivedSessionName {
  const trimmed = text?.replace(/\s+/g, ' ').trim() ?? '';
  if (!trimmed) {
    return { name: NEW_SESSION_NAME, isPlaceholder: true };
  }

  const name = generateSmartName(trimmed);
  if (!name) {
    return { name: NEW_SESSION_NAME, isPlaceholder: true };
  }

  return {
    name,
    isPlaceholder: false,
  };
}
