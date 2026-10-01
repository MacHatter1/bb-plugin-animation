/**
 * The built-in icons a node can carry.
 *
 * A small fixed set, drawn as strokes on a 24 by 24 grid, so every icon sits
 * at the same weight in every look. Named rather than supplied as markup: an
 * author picks "database", and cannot paste in something the sanitizer would
 * have to police. The names are the vocabulary the design notes suggest from.
 */

/** Icon name to the SVG drawn inside a 24 by 24 box. */
export const ICONS: Record<string, string> = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>',
  browser:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9.5 6.5h.01"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>',
  server:
    '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  queue:
    '<rect x="3" y="5" width="18" height="4" rx="1"/><rect x="3" y="10.5" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5 4.25 4.25 0 0 1 17.5 18H7z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 5"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  chip:
    '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  rocket:
    '<path d="M12 3c3.5 2 5 5.5 5 9l-2 3H9l-2-3c0-3.5 1.5-7 5-9z"/><circle cx="12" cy="10" r="1.6"/><path d="M9 18l-1 3M15 18l1 3M12 17v4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
};

export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

/**
 * Words in a part's id or label that point at an icon, most specific first.
 * Used by the design notes to suggest an icon for each box.
 */
const HINTS: Array<[RegExp, string]> = [
  [/browser|web ?page|frontend|front.?end|\bui\b|\bspa\b/, "browser"],
  [/mobile|phone|device|ios|android/, "phone"],
  [/user|customer|person|people|human|developer|\bdev\b|visitor|admin|client/, "user"],
  [/database|\bdb\b|postgres|mysql|sql|store|storage|bucket|cache|redis|warehouse|ledger/, "database"],
  [/queue|topic|stream|kafka|broker|buffer|backlog|inbox/, "queue"],
  [/dns|resolver|domain|internet|global|region|edge|cdn|root|tld/, "globe"],
  [/auth|login|identity|\bidp\b|oauth|sso|session|certificate|\bca\b|tls|secure|secret/, "lock"],
  [/cloud|saas|platform|vendor|provider/, "cloud"],
  [/key|token|credential|password/, "key"],
  [/firewall|guard|policy|gateway|proxy|limiter|breaker|shield/, "shield"],
  [/repo|branch|git|commit|merge|pull|\bpr\b/, "branch"],
  [/code|source|build|compile|script/, "code"],
  [/test|check|verify|valid|lint|review|approve|\bci\b|\bqa\b/, "check"],
  [/deploy|release|prod|launch|ship|rollout/, "rocket"],
  [/worker|job|task|process|scheduler|engine|controller|orchestr/, "gear"],
  [/cpu|compute|gpu|machine|node|instance|host|\bvm\b/, "chip"],
  [/pod|container|image|package|artifact|bundle|module/, "box"],
  [/file|doc|log|report|record|page|note/, "file"],
  [/mail|email|message|notification|sms|alert/, "mail"],
  [/timer|cron|clock|schedule|timeout|ttl/, "clock"],
  [/metric|monitor|dashboard|analytics|chart|stat/, "chart"],
  [/event|trigger|lambda|function|webhook|signal/, "bolt"],
  [/search|index|query|lookup|find/, "search"],
  [/server|service|api|backend|back.?end|app|origin|upstream/, "server"],
];

/** The icon that best fits a part's id and label, or null when nothing fits. */
export function suggestIcon(id: string, label: string | undefined): string | null {
  const text = `${id.replace(/([a-z])([A-Z])/g, "$1 $2")} ${label ?? ""}`.toLowerCase();
  for (const [pattern, icon] of HINTS) {
    if (pattern.test(text)) return icon;
  }
  return null;
}
