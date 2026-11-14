import { describe, expect, it } from 'vitest';
import { scanCss, type FindingRule } from './scan-css';

const cssFiles = import.meta.glob<string>('./**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const tsxFiles = import.meta.glob<string>('../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const TOKENS_FILE = './tokens.css';

const REQUIRED_TOKENS = [
  '--ink',
  '--paper',
  '--ghost',
  '--px',
  '--border',
  '--shadow-offset',
  '--menubar-h',
  '--titlebar-h',
  '--statusbar-h',
  '--radius',
  '--hit-min',
  '--focus-w',
  '--focus-offset',
  '--rail-w',
  '--readout-w',
  '--handle-size',
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--font-ui',
  '--font-mono',
  '--fs-12',
  '--fs-16',
  '--fs-24',
  '--fs-32',
  '--dither-50',
  '--dither-25',
  '--dither-75',
  '--stripe',
] as const;

const DITHER_TOKENS = ['--dither-50', '--dither-25', '--dither-75', '--stripe'] as const;

function fileText(files: Readonly<Record<string, string>>, path: string): string {
  const text = files[path];
  if (text === undefined) throw new Error(`Missing file in glob: ${path}`);
  return text;
}

/** Returns the value of a custom property declaration, or undefined. */
function tokenValue(css: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
  return match?.[1]?.trim();
}

function rulesOf(css: string): FindingRule[] {
  return scanCss(css).map((f) => f.rule);
}

describe('CSS files', () => {
  const entries = Object.entries(cssFiles);

  it('finds the tokens file and the other stylesheets', () => {
    const names = entries.map(([path]) => path).sort();
    expect(names).toEqual(
      [
        './base.css',
        './canvas.css',
        './controls.css',
        './ghost.css',
        './tokens.css',
        './window.css',
      ].sort(),
    );
  });

  it('loads real stylesheet text, not empty strings', () => {
    for (const [path, text] of entries) {
      expect(text.length, path).toBeGreaterThan(100);
    }
  });

  for (const [path, text] of entries.filter(([p]) => p !== TOKENS_FILE)) {
    describe(path, () => {
      it('has no color, font-family, length, gradient, blur, or opacity literal', () => {
        expect(scanCss(text)).toEqual([]);
      });

      it('does not reference --ghost', () => {
        expect(text).not.toContain('--ghost');
      });
    });
  }

  it('tokens.css defines every required token', () => {
    const tokens = fileText(cssFiles, TOKENS_FILE);
    for (const name of REQUIRED_TOKENS) {
      expect(tokenValue(tokens, name), name).toBeDefined();
    }
  });

  it('tokens.css dither tiles use the --ink and --paper hex values', () => {
    const tokens = fileText(cssFiles, TOKENS_FILE);
    const hexOf = (name: string): string => {
      const value = tokenValue(tokens, name);
      const hex = value?.match(/^#([0-9a-f]{6})$/i)?.[1];
      if (hex === undefined) throw new Error(`${name} is not a 6-digit hex color`);
      return hex.toLowerCase();
    };
    const ink = hexOf('--ink');
    const paper = hexOf('--paper');
    for (const name of DITHER_TOKENS) {
      const tile = (tokenValue(tokens, name) ?? '').toLowerCase().replace(/%23/g, '#');
      expect(tile, name).toContain(`#${ink}`);
      expect(tile, name).toContain(`#${paper}`);
    }
  });

  it('base.css turns font smoothing off', () => {
    const base = fileText(cssFiles, './base.css');
    expect(base).toMatch(/-webkit-font-smoothing\s*:\s*none/);
    expect(base).toMatch(/font-smooth\s*:\s*never/);
  });

  it('no .tsx source mentions --ghost', () => {
    const offenders = Object.entries(tsxFiles)
      .filter(([, text]) => text.includes('--ghost'))
      .map(([path]) => path);
    expect(Object.keys(tsxFiles).length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe('scanCss', () => {
  it('passes a stylesheet that uses only tokens', () => {
    const css = `
      .a { color: var(--ink); background: var(--paper) var(--dither-50); }
      .b { width: calc(3 * var(--px)); margin: 0; font-family: var(--font-ui); line-height: 1.25; }
      .c { border: var(--border) solid var(--ink); color: transparent; fill: currentcolor; }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
      #root { margin: 0; }
    `;
    expect(scanCss(css)).toEqual([]);
  });

  describe('color-literal', () => {
    it.each(['#fff', '#ffff', '#0b0b0b', '#0b0b0b80', '#FFF'])('flags %s', (hex) => {
      expect(rulesOf(`.a { color: ${hex}; }`)).toEqual(['color-literal']);
    });
    it('does not flag a hex-like id selector', () => {
      expect(scanCss('#add, #face { margin: 0; }')).toEqual([]);
    });
    it('decodes a URL-encoded hash inside a data URI', () => {
      const css = '.a { background: url("data:image/svg+xml,%3Csvg fill=\'%230b0b0b\'/%3E"); }';
      expect(rulesOf(css)).toEqual(['color-literal']);
    });
  });

  describe('color-function', () => {
    it.each([
      'rgb(0 0 0)',
      'rgba(0, 0, 0, 1)',
      'hsl(0 0% 0%)',
      'hsla(0, 0%, 0%, 1)',
      'hwb(0 0% 0%)',
      'lab(0 0 0)',
      'lch(0 0 0)',
      'oklab(0 0 0)',
      'oklch(0 0 0)',
      'color(srgb 0 0 0)',
      'color-mix(in srgb, red, blue)',
    ])('flags %s', (value) => {
      expect(rulesOf(`.a { color: ${value}; }`)).toContain('color-function');
    });
    it('does not flag a custom property named like a function', () => {
      expect(scanCss('.a { color: var(--color); }')).toEqual([]);
    });
  });

  describe('named-color', () => {
    it.each(['red', 'Black', 'rebeccapurple', 'gray'])('flags %s', (name) => {
      expect(rulesOf(`.a { border-color: ${name}; }`)).toEqual(['named-color']);
    });
    it('allows transparent and currentcolor', () => {
      expect(scanCss('.a { background: transparent; border-color: currentcolor; }')).toEqual([]);
    });
    it('ignores color words inside strings and custom property names', () => {
      expect(scanCss(".a { content: 'red'; color: var(--red); }")).toEqual([]);
    });
  });

  describe('font-family-literal', () => {
    it.each([
      'font-family: Arial, sans-serif',
      "font-family: 'VT323', monospace",
      'font-family: monospace',
      'font: 16px sans-serif',
      'font: inherit',
    ])('flags %s', (decl) => {
      expect(rulesOf(`.a { ${decl}; }`)).toContain('font-family-literal');
    });
    it.each([
      'font-family: var(--font-ui)',
      'font-family: var(--font-mono) !important',
      'font: var(--fs-16) var(--font-ui)',
    ])('passes %s', (decl) => {
      expect(rulesOf(`.a { ${decl}; }`)).not.toContain('font-family-literal');
    });
    it('flags a var() with a literal fallback', () => {
      expect(rulesOf('.a { font-family: var(--font-ui, monospace); }')).toContain(
        'font-family-literal',
      );
    });
  });

  describe('length-literal', () => {
    it.each(['1px', '0.5rem', '2em', '.5em', '16PX', '10.5px'])('flags %s', (len) => {
      expect(rulesOf(`.a { padding: ${len}; }`)).toEqual(['length-literal']);
    });
    it('flags a literal inside calc() and a negative length', () => {
      expect(rulesOf('.a { margin: calc(1px + var(--px)) -3px; }')).toEqual([
        'length-literal',
        'length-literal',
      ]);
    });
    it('flags a literal breakpoint in a media query', () => {
      expect(rulesOf('@media (min-width: 600px) { .a { margin: 0; } }')).toEqual([
        'length-literal',
      ]);
    });
    it('passes unitless numbers, percentages, and tokens', () => {
      expect(scanCss('.a { line-height: 1.25; width: 100%; height: var(--hit-min); }')).toEqual([]);
    });
  });

  describe('gradient', () => {
    it.each(['linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient'])(
      'flags %s',
      (fn) => {
        expect(rulesOf(`.a { background: ${fn}(var(--ink), var(--paper)); }`)).toEqual([
          'gradient',
        ]);
      },
    );
    it('passes a dither background', () => {
      expect(scanCss('.a { background: var(--paper) var(--dither-50); }')).toEqual([]);
    });
  });

  describe('blur', () => {
    it('flags blur(', () => {
      expect(rulesOf('.a { filter: blur(var(--px)); }')).toEqual(['blur']);
      expect(rulesOf('.a { backdrop-filter: blur(var(--px)); }')).toEqual(['blur']);
    });
    it('passes other filters-free declarations', () => {
      expect(scanCss('.a { image-rendering: pixelated; }')).toEqual([]);
    });
  });

  describe('opacity', () => {
    it('flags an opacity declaration', () => {
      expect(rulesOf('.a { opacity: 0.5; }')).toEqual(['opacity']);
      expect(rulesOf('.a { opacity: var(--half); }')).toEqual(['opacity']);
    });
    it('flags the opacity() filter function', () => {
      expect(rulesOf('.a { filter: opacity(var(--half)); }')).toEqual(['opacity']);
    });
    it('passes a declaration that only mentions a similar word', () => {
      expect(scanCss('.a { outline: var(--focus-w) dashed var(--ink); }')).toEqual([]);
    });
  });

  describe('scanner mechanics', () => {
    it('strips comments before scanning', () => {
      const css = '/* color: #fff; width: 3px; opacity: 1 */ .a { color: var(--ink); /* red */ }';
      expect(scanCss(css)).toEqual([]);
    });
    it('reports the line of the declaration', () => {
      const css = '.a {\n  color: var(--ink);\n\n  width: 3px;\n}\n';
      expect(scanCss(css)).toEqual([{ rule: 'length-literal', line: 4, match: '3px' }]);
    });
    it('keeps line numbers across a multi-line comment', () => {
      const css = '/* one\n two\n three */\n.a { margin: 1em; }';
      expect(scanCss(css).map((f) => f.line)).toEqual([4]);
    });
    it('reads the last declaration of a block with no trailing semicolon', () => {
      expect(rulesOf('.a { color: red }')).toEqual(['named-color']);
    });
    it('does not split a declaration on a semicolon inside a quoted data URI', () => {
      const css = '.a { background: url("data:image/svg+xml;utf8,<svg/>") var(--paper); }';
      expect(scanCss(css)).toEqual([]);
    });
    it('is deterministic', () => {
      const css = '.a { color: #fff; width: 2px; opacity: 1; }';
      expect(scanCss(css)).toEqual(scanCss(css));
    });
  });
});
