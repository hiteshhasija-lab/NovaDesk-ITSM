// Checking the ID token an identity provider hands back after sign-in. Only the algorithms real providers use
// for ID tokens (RS256 and ES256) are accepted, with a key from the provider's published key set, so a token
// that is unsigned ("alg": "none"), signed with a shared secret (HS256, the classic key-confusion trick) or
// signed by any other key is refused. Then the claims that tie the token to this sign-in are checked: issuer,
// audience (this application), expiry and the one-time nonce.
'use strict';
const crypto = require('crypto');

class TokenError extends Error {
  constructor(message, code = 'invalid_token') { super(message); this.code = code; }
}

const ALGORITHMS = {
  RS256: { kty: 'RSA' },
  ES256: { kty: 'EC', crv: 'P-256', ieee: true },
};

function parts(token) {
  const pieces = String(token || '').split('.');
  if (pieces.length !== 3 || pieces.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new TokenError('The sign-in token is not well formed.');
  try {
    return { header: JSON.parse(Buffer.from(pieces[0], 'base64url').toString()), claims: JSON.parse(Buffer.from(pieces[1], 'base64url').toString()), signature: Buffer.from(pieces[2], 'base64url'), signed: `${pieces[0]}.${pieces[1]}` };
  } catch {
    throw new TokenError('The sign-in token is not well formed.');
  }
}

function pickKey(jwks, header, spec) {
  const candidates = ((jwks && jwks.keys) || []).filter((k) => (k.use === undefined || k.use === 'sig') && k.kty === spec.kty && (!spec.crv || k.crv === spec.crv) && (!k.alg || k.alg === header.alg));
  if (header.kid) return candidates.find((k) => k.kid === header.kid) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

// Returns the claims, or throws a TokenError whose message is safe to show a person. A TokenError with
// code 'unknown_kid' means the key set may be out of date: fetch it again and retry once.
function verifyIdToken(token, { jwks, issuer, clientId, nonce, now = Date.now(), skewSeconds = 60 }) {
  const { header, claims, signature, signed } = parts(token);
  const spec = ALGORITHMS[header.alg];
  if (!spec) throw new TokenError('The sign-in token uses a signature type NovaDesk does not accept.');
  const jwk = pickKey(jwks, header, spec);
  if (!jwk) throw new TokenError('The sign-in token was signed with a key NovaDesk does not know.', 'unknown_kid');

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    ok = crypto.verify('sha256', Buffer.from(signed), spec.ieee ? { key, dsaEncoding: 'ieee-p1363' } : key, signature);
  } catch { ok = false; }
  if (!ok) throw new TokenError('The sign-in token signature is not valid.');

  const skew = skewSeconds * 1000;
  if (claims.iss !== issuer) throw new TokenError('The sign-in token came from a different identity provider than the one configured.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new TokenError('The sign-in token was issued for a different application.');
  if (audiences.length > 1 && claims.azp !== clientId) throw new TokenError('The sign-in token was issued for a different application.');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now - skew) throw new TokenError('The sign-in token has expired. Try again.');
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + skew) throw new TokenError('The sign-in token is not valid yet. Check the server clock.');
  if (typeof claims.iat === 'number' && claims.iat * 1000 > now + skew) throw new TokenError('The sign-in token is dated in the future. Check the server clock.');
  if (!nonce || claims.nonce !== nonce) throw new TokenError('The sign-in token does not belong to this sign-in attempt.');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new TokenError('The sign-in token has no subject.');
  return claims;
}

module.exports = { verifyIdToken, TokenError };
