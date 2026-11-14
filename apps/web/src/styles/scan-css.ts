/**
 * CSS token scanner. Pure: text in, findings out. It enforces the rule that
 * every color, length, and font family outside tokens.css comes from a token,
 * and that the design language bans gradients, blur, and opacity.
 */

export type FindingRule =
  | 'color-literal'
  | 'color-function'
  | 'named-color'
  | 'font-family-literal'
  | 'length-literal'
  | 'gradient'
  | 'blur'
  | 'opacity';

export interface Finding {
  readonly rule: FindingRule;
  /** 1-based line of the declaration or at-rule that holds the match. */
  readonly line: number;
  /** The matched text. */
  readonly match: string;
}

/** CSS named colors, lowercase, minus `transparent` and `currentcolor`. */
const NAMED_COLORS: ReadonlySet<string> = new Set([
  'aliceblue',
  'antiquewhite',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'black',
  'blanchedalmond',
  'blue',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'fuchsia',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'gray',
  'green',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'lime',
  'limegreen',
  'linen',
  'magenta',
  'maroon',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'navy',
  'oldlace',
  'olive',
  'olivedrab',
  'orange',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'purple',
  'rebeccapurple',
  'red',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'silver',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'teal',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'whitesmoke',
  'yellow',
  'yellowgreen',
]);

const HEX_COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi;
const COLOR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\s*\(/gi;
const LENGTH_LITERAL = /(?<![\w.])(?:\d+\.?\d*|\.\d+)(?:px|rem|em)(?![\w-])/gi;
const GRADIENT = /(?<![\w])(?:[a-z]+-)*(?:linear|radial|conic)-gradient\s*\(/gi;
const BLUR = /(?<![\w-])blur\s*\(/gi;
const OPACITY_FUNCTION = /(?<![\w-])opacity\s*\(/gi;
const IDENTIFIER = /-{0,2}[a-z_][\w-]*/gi;
const VAR_REFERENCE = /var\(\s*--[\w-]+\s*\)/gi;

/** Replaces each comment with the same number of newlines, keeping line numbers. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Removes quoted strings and `url(...)` bodies so words inside them are not read as keywords. */
function withoutStringsAndUrls(value: string): string {
  return value.replace(/url\([^)]*\)/gi, ' ').replace(/"[^"]*"|'[^']*'/g, ' ');
}

function collect(
  rule: FindingRule,
  pattern: RegExp,
  value: string,
  line: number,
): readonly Finding[] {
  return Array.from(value.matchAll(pattern), (m) => ({ rule, line, match: m[0] }));
}

function scanAtRulePrelude(prelude: string, line: number): readonly Finding[] {
  return collect('length-literal', LENGTH_LITERAL, prelude, line);
}

function scanDeclaration(property: string, rawValue: string, line: number): readonly Finding[] {
  // A data URI may hold a URL-encoded hash, as in `%23f6f3ec`. Decode it so
  // that a hex color hidden in a tile is still a hex color.
  const value = rawValue.replace(/%23/gi, '#');
  const prop = property.trim().toLowerCase();
  const findings: Finding[] = [
    ...collect('color-literal', HEX_COLOR, value, line),
    ...collect('color-function', COLOR_FUNCTION, value, line),
    ...collect('length-literal', LENGTH_LITERAL, value, line),
    ...collect('gradient', GRADIENT, value, line),
    ...collect('blur', BLUR, value, line),
    ...collect('opacity', OPACITY_FUNCTION, value, line),
  ];

  for (const m of withoutStringsAndUrls(value).matchAll(IDENTIFIER)) {
    if (NAMED_COLORS.has(m[0].toLowerCase())) {
      findings.push({ rule: 'named-color', line, match: m[0] });
    }
  }

  if (prop === 'font-family' || prop === 'font') {
    const rest = value
      .replace(/!\s*important/gi, '')
      .replace(VAR_REFERENCE, '')
      .replace(/[\s,]/g, '');
    if (rest !== '') {
      findings.push({ rule: 'font-family-literal', line, match: value.trim() });
    }
  }

  if (/opacity$/.test(prop)) {
    findings.push({ rule: 'opacity', line, match: prop });
  }

  return findings;
}

/**
 * Scans CSS text and returns every token-rule violation. An empty array means
 * the text is clean. Comments are removed before scanning.
 */
export function scanCss(text: string): readonly Finding[] {
  const css = stripComments(text);
  const findings: Finding[] = [];

  let buffer = '';
  let bufferLine = 1;
  let line = 1;
  let parenDepth = 0;
  let quote: string | null = null;

  const flush = (endsBlock: boolean): void => {
    const segment = buffer.trim();
    buffer = '';
    if (segment === '') return;
    if (segment.startsWith('@')) {
      findings.push(...scanAtRulePrelude(segment, bufferLine));
      return;
    }
    if (endsBlock) return; // A selector list: no declarations to read.
    const colon = segment.indexOf(':');
    if (colon === -1) return;
    findings.push(
      ...scanDeclaration(segment.slice(0, colon), segment.slice(colon + 1), bufferLine),
    );
  };

  for (const ch of css) {
    if (ch === '\n') line += 1;
    if (quote !== null) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (buffer.trim() === '') bufferLine = line;
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === '(') parenDepth += 1;
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);

    if (parenDepth === 0 && (ch === '{' || ch === '}' || ch === ';')) {
      flush(ch === '{');
      continue;
    }
    if (buffer.trim() === '' && ch.trim() !== '') bufferLine = line;
    buffer += ch;
  }
  flush(false);

  return findings;
}
