// imgutil.js - image link checking shared by the nextbot dialog and the nextbot sprite.
export const MAX_URL = 1500;

// only http(s) links and small base64 images are allowed
export function safeImageUrl(u) {
  return typeof u === 'string' && u.length <= MAX_URL && /^(https?:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i.test(u);
}

// loads with crossOrigin so the result is guaranteed to be usable as a webgl texture.
// resolves the <img>, rejects with a human readable error.
export function loadImage(url, timeout = 10000) {
  return new Promise((res, rej) => {
    if (!safeImageUrl(url)) return rej(new Error('link must start with http:// or https://'));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = setTimeout(() => { img.src = ''; rej(new Error('timed out loading that link')); }, timeout);
    img.onload = () => { clearTimeout(t); res(img); };
    img.onerror = () => { clearTimeout(t); rej(new Error('invalid: not an image, bad link, or the site blocks use in other pages')); };
    img.src = url;
  });
}
