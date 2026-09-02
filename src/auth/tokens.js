/**
 * OAuth2 client credentials, and the scopes a token carries.
 *
 * The client credentials grant, and only that one. There is no user here: the
 * caller is another piece of software, it holds a secret of its own, and every
 * other grant type exists to get a human's consent to something. Offering
 * `password` or `authorization_code` on a service like this is offering doors
 * that lead nowhere and have to be defended anyway.
 *
 * Two scopes, and they are not a formality:
 *
 *   `ocr:write`  submit a document
 *   `ocr:read`   collect a result
 *
 * They separate because the jobs are asynchronous. Something has to submit and
 * something has to poll, and those are often different processes with different
 * exposure — a public-facing uploader that may submit and must never be able to
 * read back somebody else's result, and a worker that reads and never submits.
 * A single scope would make the separation impossible to express.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export function tokenIssuer({ secret, issuer, audience, at = () => Date.now() }) {
  if (!secret || secret.length < 32) {
    throw new Error(
      'the token signing secret must be at least 32 characters — set OAUTH_JWT_SECRET'
    );
  }

  return {
    /**
     * A token for a client, carrying the scopes it asked for AND holds.
     *
     * The intersection, not the request and not the grant. A client asking for
     * a scope it does not hold gets a token without it rather than an error:
     * that is what the specification says, and it means a caller that asks for
     * everything and uses what it gets keeps working when its permissions are
     * narrowed.
     */
    issue(client, asked) {
      const wanted = String(asked ?? '').split(/\s+/).filter(Boolean);
      const granted = wanted.length === 0 ? client.scope : wanted.filter((one) => client.scope.includes(one));

      const now = Math.floor(at() / 1000);

      const token = jwt.sign(
        {
          scope: granted.join(' '),
          // A unique id per token, so one can be named in a log or refused
          // individually later without inventing a new claim to hang that on.
          jti: crypto.randomUUID(),

          // Issued at OUR clock, not the library's. Without this `expiresIn` is
          // measured from `Date.now()` whatever this service has been told the
          // time is — so a clock that has been injected is honoured for the
          // three fields printed in the answer and quietly ignored for the one
          // that decides when the token stops working.
          iat: now,
        },
        secret,
        {
          algorithm: 'HS256',
          issuer,
          audience,
          subject: client.id,
          expiresIn: client.tokenTtlSeconds,
        }
      );

      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: client.tokenTtlSeconds,
        scope: granted.join(' '),
        issued_at: new Date(now * 1000).toISOString(),
      };
    },

    /**
     * Reads a token, or says why it will not.
     *
     * The algorithm is named. Without `algorithms`, a library will honour the
     * `alg` header of the token it was given — including `none` — which lets
     * anybody who can write JSON mint an administrator. It is the oldest hole
     * in JWT and it is still open by default in several libraries.
     */
    read(token) {
      try {
        const claims = jwt.verify(token, secret, {
          algorithms: ['HS256'],
          issuer,
          audience,
        });

        return {
          ok: true,
          clientId: claims.sub,
          scope: String(claims.scope ?? '').split(/\s+/).filter(Boolean),
          expiresAt: new Date(claims.exp * 1000).toISOString(),
          id: claims.jti,
        };
      } catch (error) {
        const why =
          error.name === 'TokenExpiredError'
            ? 'the token has expired'
            : error.name === 'JsonWebTokenError'
              ? 'the token is not valid'
              : 'the token could not be read';

        return { ok: false, why };
      }
    },
  };
}

/** True when a token carries every scope a route asks for. */
export function carries(scope, needed) {
  return needed.every((one) => scope.includes(one));
}
