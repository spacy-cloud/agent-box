/**
 * The page's CSP allows `<style>` elements only with the per-load nonce from `<meta name="abox-style-nonce">`
 * (the main process injects it, see `main/security.ts`). Libraries such as xterm.js create style elements through
 * `document.createElement('style')`; this stamps the nonce onto exactly those elements. Nothing else changes:
 * scripts, images and connections remain blocked by the CSP.
 */
export function installStyleNonce(doc: Document = document): void {
  const nonce = doc.querySelector('meta[name="abox-style-nonce"]')?.getAttribute('content');
  // Dev server: the placeholder is not replaced and the dev CSP allows inline styles anyway.
  if (!nonce || nonce.startsWith('__')) return;
  const proto = Document.prototype;
  const original = proto.createElement;
  proto.createElement = function patched(this: Document, tag: string, options?: ElementCreationOptions) {
    const el = original.call(this, tag, options);
    if (typeof tag === 'string' && tag.toLowerCase() === 'style') (el as HTMLStyleElement).nonce = nonce;
    return el;
  } as typeof proto.createElement;
}
