import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import {
  sanitizeHtmlString,
  sanitizeWithDomPurify,
  sanitizeWithSanitizeHtml,
  type HtmlOptions,
} from './sanitize';
import { renderMarkdown, sanitizeHtml } from './markdown';

// The two engines must hold the same line: the server one (no DOM, Cloudflare Workers)
// and the browser one. Every payload runs through both.
const domWindow = new JSDOM('').window;
const purify = createDOMPurify(domWindow as unknown as Window & typeof globalThis);

const engines: Record<string, (html: string, options?: HtmlOptions) => string> = {
  'sanitize-html (server)': sanitizeWithSanitizeHtml,
  'DOMPurify (browser)': (html, options) => sanitizeWithDomPurify(purify, html, options),
};

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.test/x.js></SCRIPT>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(1)">',
  '<IMG SRC=javascript:alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="  JaVaScRiPt:alert(1)">x</a>',
  '<a href="java\tscript:alert(1)">x</a>',
  '<a href="java&#x0A;script:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<svg onload=alert(1)></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<math href="javascript:alert(1)">x</math>',
  '<style>@import "https://evil.test/x.css"; body{display:none}</style>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<body onload=alert(1)>',
  '<form action="javascript:alert(1)"><button>go</button></form>',
  '<form><input name=x><input type=submit formaction="javascript:alert(1)"></form>',
  '<input type="text" value="x" onfocus="alert(1)" autofocus>',
  '<details open ontoggle=alert(1)>x</details>',
  '<video><source onerror="alert(1)"></video>',
  '<a href="https://ok.test" onclick="alert(1)">x</a>',
  '<p onmouseover="alert(1)">x</p>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<textarea><script>alert(1)</script></textarea>',
  '<title><img src=x onerror=alert(1)></title>',
  '<xmp><img src=x onerror=alert(1)></xmp>',
  '<template><img src=x onerror=alert(1)></template>',
  '<!--><img src=x onerror=alert(1)>-->',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src="x`` `<script>alert(1)</script>"``>',
  '<a href="https://ok.test" target="_blank">x</a><a href="#" rel="opener">y</a>',
  '<img srcset="javascript:alert(1) 1x, https://ok.test/a.png 2x">',
  '<img src="data:text/html,<script>alert(1)</script>">',
  '<base href="https://evil.test/">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="https://evil.test/x.css">',
  '<a id="cookie" name="cookie">x</a><img name="body" id="documentElement">',
];

// Both engines are compared on the DOM they produce, not on how they spell a boolean.
const canon = (html: string) => new JSDOM(`<body>${html}</body>`).window.document.body.innerHTML;

const stripControls = (value: string) =>
  Array.from(value)
    .filter((char) => char.charCodeAt(0) > 32)
    .join('');

// What the browser would build from the output: the invariants are read off a DOM, not
// off the string.
function danger(output: string): string[] {
  const doc = new JSDOM(`<body>${output}</body>`).window.document;
  const found: string[] = [];
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (
      [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'form',
        'base',
        'meta',
        'link',
        'template',
        'noscript',
        'title',
        'textarea',
        'xmp',
        'button',
      ].includes(tag)
    )
      found.push(`<${tag}>`);
    if (tag === 'input' && el.getAttribute('type') !== 'checkbox') found.push('<input>');
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) found.push(`${tag}[${attr.name}]`);
      if (/^(formaction|srcdoc|xlink:href|action)$/i.test(attr.name))
        found.push(`${tag}[${attr.name}]`);
      const value = stripControls(attr.value).toLowerCase();
      if (/^(javascript|vbscript):/.test(value)) found.push(`${tag}[${attr.name}]=${value}`);
      if (/^data:(?!image\/)/.test(value)) found.push(`${tag}[${attr.name}]=${value}`);
      if (['id', 'name'].includes(attr.name) && /^(cookie|body|documentelement)$/i.test(attr.value))
        found.push(`clobber ${attr.value}`);
      if (attr.name === 'style' && /url\(|expression|@import/i.test(attr.value))
        found.push('style');
      if (attr.name === 'srcset' && /javascript:/i.test(attr.value)) found.push('srcset');
    }
  }
  return found;
}

for (const [name, run] of Object.entries(engines)) {
  describe(`${name}: XSS payloads`, () => {
    for (const payload of PAYLOADS) {
      it(`neutralises ${payload.slice(0, 60)}`, () => {
        assert.deepEqual(danger(run(payload)), []);
        assert.deepEqual(danger(run(`<p>${payload}</p>`, { newTabLinks: true })), []);
      });
    }

    it('keeps ordinary markup', () => {
      const html =
        '<h2>Title</h2><p>a <strong>b</strong> <em>c</em> <code class="language-js">d</code></p>' +
        '<ul><li>one</li></ul><blockquote>q</blockquote><pre><code>x &lt; y</code></pre>' +
        '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td colspan="2">c</td></tr></tbody></table>' +
        '<p><a href="https://ok.test/a?b=1&amp;c=2" title="t">link</a> <a href="mailto:a@b.test">m</a></p>' +
        '<p><img src="https://ok.test/a.png" alt="a" width="10"></p><hr>';
      assert.equal(run(html), html);
    });

    it('keeps relative, anchor and protocol-relative urls', () => {
      assert.equal(
        run(
          '<a href="/x/y">a</a><a href="#frag">b</a><a href="//cdn.test/x">c</a><a href="x.html">d</a>',
        ),
        '<a href="/x/y">a</a><a href="#frag">b</a><a href="//cdn.test/x">c</a><a href="x.html">d</a>',
      );
    });

    it('keeps a data: image, which cannot run script as an <img>', () => {
      const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
      assert.equal(run(html), html);
    });

    it('keeps the task-list checkbox marked emits, and only that input', () => {
      assert.equal(
        canon(run('<ul><li><input disabled="" type="checkbox"> todo</li></ul>')),
        canon('<ul><li><input disabled="" type="checkbox"> todo</li></ul>'),
      );
      assert.equal(run('<p>a<input type="password" name="p">b</p>'), '<p>ab</p>');
    });

    it('removes the content of script and style, not only the tags', () => {
      assert.equal(
        run('<p>a</p><script>steal()</script><style>p{}</style><p>b</p>'),
        '<p>a</p><p>b</p>',
      );
    });

    it('escapes text so it cannot become markup', () => {
      assert.equal(
        run('<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>'),
        '<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>',
      );
      assert.equal(run('a < b'), 'a &lt; b');
    });

    it('does not open a link in a new tab once its url was refused', () => {
      assert.equal(run('<a href="javascript:alert(1)">x</a>', { newTabLinks: true }), '<a>x</a>');
    });

    it('drops style declarations that lay a block over the page or load a resource', () => {
      assert.equal(
        canon(
          run(
            '<p style="text-align: center; position: fixed; inset: 0; background: url(//e.test/x)">x</p>',
          ),
        ),
        canon('<p style="text-align: center">x</p>'),
      );
      assert.equal(canon(run('<p style="position:fixed">x</p>')), canon('<p>x</p>'));
    });

    it('drops a data: src that is not a raster image', () => {
      assert.equal(run('<img src="data:text/html;base64,PHNjcmlwdD4=">'), '<img>');
    });

    it('drops an image style that would lay the image over the page', () => {
      const overlay =
        '<img src="/a.png" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:9999">';
      assert.equal(run(overlay), '<img src="/a.png">');
      assert.equal(
        run('<img src="/a.png" style="width: 320px; max-width: 100%">'),
        '<img src="/a.png" style="width: 320px; max-width: 100%">',
      );
    });

    it('never lets the author choose target; newTabLinks sets it with noreferrer', () => {
      assert.ok(!/target=/.test(run('<a href="https://ok.test" target="_blank">x</a>')));
      assert.equal(
        run('<a href="https://ok.test" target="_top">x</a><a>no href</a>', { newTabLinks: true }),
        '<a href="https://ok.test" target="_blank" rel="noreferrer">x</a><a>no href</a>',
      );
    });
  });
}

describe('server engine specifics', () => {
  it('survives pathological nesting and attribute floods without throwing', () => {
    const nested = '<div>'.repeat(5000) + 'x' + '</div>'.repeat(5000);
    assert.ok(sanitizeWithSanitizeHtml(nested).includes('x'));
    const attrs = `<a ${'data-x="1" '.repeat(5000)}href="javascript:1">x</a>`;
    assert.deepEqual(danger(sanitizeWithSanitizeHtml(attrs)), []);
  });

  it('drops the id of a DOM-clobbering name but keeps an anchor id', () => {
    assert.equal(
      sanitizeWithSanitizeHtml('<h2 id="user-content-notes">n</h2>'),
      '<h2 id="user-content-notes">n</h2>',
    );
    assert.equal(sanitizeWithSanitizeHtml('<h2 id="cookie">n</h2>'), '<h2>n</h2>');
  });

  it('is what runs when there is no DOM', () => {
    assert.equal(typeof window, 'undefined');
    assert.equal(sanitizeHtmlString('<img src=x onerror=alert(1)>'), '<img src="x">');
  });
});

describe('markdown goes through the sanitizer', () => {
  it('strips raw html in markdown source', () => {
    for (const source of [
      'hello <script>alert(1)</script>',
      '[x](javascript:alert(1))',
      '![x](javascript:alert(1))',
      '<img src=x onerror=alert(1)>',
      '<details open ontoggle=alert(1)><summary>s</summary></details>',
      '[x]: javascript:alert(1)\n\n[x]',
      '<a href="javascript:alert(1)">x</a>',
      '`<script>` is safe in code, <b onmouseover=alert(1)>not here</b>',
    ]) {
      assert.deepEqual(danger(renderMarkdown(source)), [], source);
      assert.deepEqual(danger(renderMarkdown(source, { newTabLinks: true })), [], source);
    }
  });

  it('keeps code content as text', () => {
    assert.equal(
      renderMarkdown('`<script>alert(1)</script>`'),
      '<p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>\n',
    );
  });

  it('opens links of release notes in a new tab', () => {
    assert.equal(
      sanitizeHtml('<p><a href="https://ok.test/r">r</a></p>', { newTabLinks: true }),
      '<p><a href="https://ok.test/r" target="_blank" rel="noreferrer">r</a></p>',
    );
  });
});
