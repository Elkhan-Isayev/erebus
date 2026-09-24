import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, headersPreview, highlightJson } from './format';

describe('highlightJson', () => {
  // Message payloads come from the broker and end up as HTML in the message view.
  it('escapes markup inside a message instead of rendering it', () => {
    const html = highlightJson('{"note":"<img src=x onerror=alert(1)>"}');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes markup in text that is not JSON at all', () => {
    expect(highlightJson('</span><script>x()</script>')).toBe('&lt;/span&gt;&lt;script&gt;x()&lt;/script&gt;');
  });

  it('escapes ampersands before anything else, so entities are not double-decoded', () => {
    expect(highlightJson('"&lt;"')).toBe('<span class="json-string">"&amp;lt;"</span>');
  });

  it('tags keys, strings, numbers, booleans and null', () => {
    const html = highlightJson('{"a": "b", "n": -1.5e3, "t": true, "z": null}');
    expect(html).toContain('<span class="json-key">"a":</span>');
    expect(html).toContain('<span class="json-string">"b"</span>');
    expect(html).toContain('<span class="json-number">-1.5e3</span>');
    expect(html).toContain('<span class="json-bool">true</span>');
    expect(html).toContain('<span class="json-null">null</span>');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [-5, '0 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [104_857_600, '100.0 MB'],
    ['2048', '2.0 KB'],
    [null, '0 B'],
    ['not a number', '0 B'],
  ])('%s → %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    ['-1', 'infinite'],
    [0, '0'],
    [250, '250ms'],
    [1_500, '1.5s'],
    [604_800_000, '7d'],
    [5_400_000, '1.5h'],
  ])('%s → %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe('headersPreview', () => {
  it('is empty without headers', () => {
    expect(headersPreview([])).toBe('');
  });

  it('inlines JSON values and keeps plain ones as text', () => {
    expect(
      headersPreview([
        { key: 'trace', value: '{"id":7}' },
        { key: 'source', value: 'billing' },
      ]),
    ).toBe('{"trace":{"id":7},"source":"billing"}');
  });

  it('gathers a repeated header into an array instead of dropping values', () => {
    expect(
      headersPreview([
        { key: 'hop', value: 'a' },
        { key: 'hop', value: 'b' },
        { key: 'hop', value: 'c' },
      ]),
    ).toBe('{"hop":["a","b","c"]}');
  });
});
