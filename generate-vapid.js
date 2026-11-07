// Vygeneruje dvojici VAPID klíčů pro push notifikace. Spusť lokálně:  node generate-vapid.js
// Veřejný klíč patří do index.html (CFG.vapid) a do Supabase Secrets (VAPID_PUBLIC).
// Soukromý klíč patří JEN do Supabase Secrets (VAPID_PRIVATE). Nikam ho nesdílej ani neposílej do GitHubu.
const c = require('crypto');
const { publicKey, privateKey } = c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pj = publicKey.export({ format: 'jwk' }), vj = privateKey.export({ format: 'jwk' });
const pub = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, 'base64url'), Buffer.from(pj.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC  =', pub);
console.log('VAPID_PRIVATE =', vj.d);
