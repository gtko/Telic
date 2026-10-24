import createDOMPurify, { type DOMPurify, type UponSanitizeAttributeHookEvent } from 'dompurify';
import sanitizeHtmlLib, { type IFrame, type IOptions } from 'sanitize-html';
import { allowedImageStyle } from '@/utils/imageStyle';

// One entry point for "make this HTML safe for dangerouslySetInnerHTML", with the same
// policy on both runtimes the app renders on:
//
//  - In a browser (and in a test that installs a window) DOMPurify runs on the real DOM
//    parser, the strongest guarantee against mutation XSS.
//  - On the server (Cloudflare Workers, no DOM, no jsdom) sanitize-html runs instead. It
//    parses with htmlparser2 and writes the result back out itself from an allow-list,
//    escaping text and attribute values, so nothing it emits is re-interpreted by a
//    second parser on the server. Reaching the client, the markup is plain allow-listed
//    tags, none of the contexts (svg, math, noscript, style, textarea, template) that
//    mutation XSS depends on.
//
// Fails closed: a DOM that DOMPurify reports unsupported falls back to sanitize-html,
// never to the unsanitized input.

// Content whose links lead away from the current view (release notes, agent chat)
// asks for newTabLinks, so following one does not replace what the reader was on.
export interface HtmlOptions {
  newTabLinks?: boolean;
}

// Schemes DOMPurify lets through by default (ALLOWED_URI_REGEXP).
const URL_SCHEMES = [
  'http',
  'https',
  'ftp',
  'ftps',
  'mailto',
  'tel',
  'callto',
  'sms',
  'cid',
  'xmpp',
  'matrix',
];

// ---- browser: DOMPurify ----------------------------------------------------------

let browser: { win: unknown; purify: DOMPurify } | null = null;

// DOMPurify bound to the current window, or null where there is no usable DOM.
export function browserPurify(): DOMPurify | null {
  if (typeof window === 'undefined' || typeof window.document === 'undefined') return null;
  if (browser?.win !== window) {
    browser = { win: window, purify: createDOMPurify(window) };
  }
  return browser.purify.isSupported ? browser.purify : null;
}

// Only the task-list checkbox is an input; no other form control survives.
function dropOtherInputs(node: Element): void {
  if (node.tagName === 'INPUT' && node.getAttribute('type')?.toLowerCase() !== 'checkbox')
    node.parentNode?.removeChild(node);
}

function newTab(node: Element): void {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer');
  }
}

// A data: URI is kept only for a raster image; any other type is dropped, whatever
// element carries it.
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]*$/i;

function allowedDataUri(value: string): boolean {
  return !/^\s*data:/i.test(value) || DATA_IMAGE.test(value.trim());
}

// Declarations that lay an element over the page, or load something, whichever element
// carries them: the style of a block is applied for every reader of the text.
const LAYOUT_PROPERTY =
  /^(?:position|inset(?:-.*)?|top|right|bottom|left|z-index|float|clip|clip-path|transform|content|behavior|-moz-binding)$/;
const UNSAFE_VALUE = /url\(|expression\(|@import|\\|javascript:|vbscript:|[<>]/i;

// `style` on anything but an image: kept as written, minus the declarations above.
// null when nothing is left.
function allowedBlockStyle(css: string | null | undefined): string | null {
  if (!css) return null;
  const kept = css.split(';').filter((declaration) => {
    const colon = declaration.indexOf(':');
    if (colon === -1) return false;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    return !LAYOUT_PROPERTY.test(property) && !UNSAFE_VALUE.test(declaration);
  });
  return kept.length > 0 ? kept.map((d) => d.trim()).join('; ') : null;
}

// DOMPurify keeps `style` as it is, and on an image that is enough to cover the
// page (see allowedImageStyle).
function restrictAttributes(node: Element, data: UponSanitizeAttributeHookEvent): void {
  if (data.attrName === 'src' && !allowedDataUri(data.attrValue)) {
    data.keepAttr = false;
    return;
  }
  if (data.attrName !== 'style') return;
  const style =
    node.tagName === 'IMG' ? allowedImageStyle(data.attrValue) : allowedBlockStyle(data.attrValue);
  if (style) data.attrValue = style;
  else data.keepAttr = false;
}

export function sanitizeWithDomPurify(
  purify: DOMPurify,
  html: string,
  options?: HtmlOptions,
): string {
  purify.addHook('uponSanitizeAttribute', restrictAttributes);
  purify.addHook('afterSanitizeAttributes', dropOtherInputs);
  if (options?.newTabLinks) purify.addHook('afterSanitizeAttributes', newTab);
  try {
    return purify.sanitize(html, { ALLOWED_TAGS: TEXT_TAGS });
  } finally {
    purify.removeHook('afterSanitizeAttributes', dropOtherInputs);
    purify.removeHook('afterSanitizeAttributes', newTab);
    purify.removeHook('uponSanitizeAttribute', restrictAttributes);
  }
}

// ---- server: sanitize-html -------------------------------------------------------

const TEXT_TAGS = [
  'a',
  'abbr',
  'acronym',
  'address',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'font',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'small',
  'source',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'tt',
  'u',
  'ul',
  'var',
  'wbr',
];

// Names a page element can shadow on `document`/`window` (DOM clobbering). DOMPurify
// strips these from id and name; here the id is simply dropped.
const CLOBBERABLE = new Set([
  'activeelement',
  'all',
  'anchors',
  'applets',
  'attributes',
  'baseuri',
  'body',
  'children',
  'cookie',
  'currentscript',
  'defaultview',
  'doctype',
  'documentelement',
  'domain',
  'embeds',
  'forms',
  'head',
  'images',
  'implementation',
  'links',
  'location',
  'name',
  'nodetype',
  'ownerdocument',
  'parentnode',
  'plugins',
  'referrer',
  'scripts',
  'self',
  'top',
  'window',
]);
const SAFE_ID = /^[A-Za-z][\w:.-]{0,127}$/;

// Whether a url survives the scheme filter: relative, or one of URL_SCHEMES. Control
// characters and spaces are ignored the way a browser ignores them in a scheme.
function allowedUrl(value: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(
    Array.from(value)
      .filter((char) => char.charCodeAt(0) > 32)
      .join('')
      .toLowerCase(),
  );
  return !scheme || URL_SCHEMES.includes(scheme[1]);
}

function keepId(id: string): boolean {
  return SAFE_ID.test(id) && !CLOBBERABLE.has(id.toLowerCase());
}

function serverOptions(options?: HtmlOptions): IOptions {
  const newTabLinks = options?.newTabLinks === true;
  return {
    allowedTags: TEXT_TAGS,
    allowedAttributes: {
      '*': ['class', 'id', 'title', 'lang', 'dir', 'style', 'role', 'data-*', 'aria-*'],
      a: ['href', 'rel', 'target', 'hreflang', 'download'],
      img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
      source: ['src', 'srcset', 'sizes', 'media', 'type'],
      input: ['type', 'checked', 'disabled'],
      ol: ['start', 'type', 'reversed'],
      li: ['value'],
      details: ['open'],
      time: ['datetime'],
      q: ['cite'],
      blockquote: ['cite'],
      del: ['cite', 'datetime'],
      ins: ['cite', 'datetime'],
      td: ['colspan', 'rowspan', 'headers', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'headers', 'scope', 'align', 'valign'],
      col: ['span', 'align', 'valign'],
      colgroup: ['span', 'align', 'valign'],
      table: ['align', 'summary', 'border', 'cellpadding', 'cellspacing'],
      tr: ['align', 'valign'],
      p: ['align'],
      div: ['align'],
      font: ['color', 'face', 'size'],
      bdo: ['dir'],
    },
    allowedSchemes: URL_SCHEMES,
    allowedSchemesByTag: { img: [...URL_SCHEMES, 'data'], source: [...URL_SCHEMES, 'data'] },
    // The style attribute is filtered above, as written, not re-serialized.
    parseStyleAttributes: false,
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: true,
    selfClosing: ['img', 'br', 'hr', 'col', 'wbr', 'source', 'input'],
    // Removed with their content, not just unwrapped.
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'noscript',
      'template',
      'iframe',
      'title',
      'xmp',
      'noembed',
      'noframes',
      'object',
      'embed',
      'svg',
      'math',
      'plaintext',
    ],
    // Only the task-list checkbox marked and GitHub render; no other form control.
    exclusiveFilter: (frame: IFrame) =>
      frame.tag === 'input' && String(frame.attribs.type ?? '').toLowerCase() !== 'checkbox',
    transformTags: {
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if ('id' in next && !keepId(next.id)) delete next.id;
        if ('style' in next) {
          const style =
            tagName === 'img' ? allowedImageStyle(next.style) : allowedBlockStyle(next.style);
          if (style) next.style = style;
          else delete next.style;
        }
        if (next.src !== undefined && !allowedDataUri(next.src)) delete next.src;
        if (tagName === 'a') {
          // `target` is the reader's call, never the author's; the caller asks for it.
          delete next.target;
          if (newTabLinks && next.href !== undefined && allowedUrl(next.href)) {
            next.target = '_blank';
            next.rel = 'noreferrer';
          }
        }
        return { tagName, attribs: next };
      },
    },
  };
}

export function sanitizeWithSanitizeHtml(html: string, options?: HtmlOptions): string {
  // sanitize-html closes void tags as `<br />`; DOMPurify writes `<br>`. ` />` can only
  // be a tag end here: a `>` in text or in an attribute value is always escaped.
  return sanitizeHtmlLib(html, serverOptions(options)).replaceAll(' />', '>');
}

// ---- entry point -----------------------------------------------------------------

export function sanitizeHtmlString(html: string, options?: HtmlOptions): string {
  const purify = browserPurify();
  return purify
    ? sanitizeWithDomPurify(purify, html, options)
    : sanitizeWithSanitizeHtml(html, options);
}
