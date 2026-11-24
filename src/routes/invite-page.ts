import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { mergePaths, operation } from '../openapi/operation.js';
import { type InviteState, type ShareService } from '../services/share-service.js';

/** Custom scheme the app registers for invites from servers without an App Link. */
const APP_SCHEME = 'uhabits';

const CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const openApiPaths = mergePaths(
  operation({
    method: 'get',
    path: '/invite/{code}',
    tag: 'Invites & subscriptions',
    summary: 'Invite landing page',
    description: [
      'Small HTML page that the invite link opens in a browser. It shows no content of the',
      'share. In the browser, JavaScript reads the key from the fragment (`#k=…&v=1`, never',
      `sent to the server) and offers an "open in app" link with the custom scheme`,
      `\`${APP_SCHEME}://invite?server=<server-base>&code=<code>&k=<key>&v=1\`,`,
      'plus where to get the app. Expired, redeemed or ended invites are shown as such.',
    ].join(' '),
    auth: 'none',
    pathParams: { code: 'Invite code' },
    responses: {
      200: { description: 'Landing page for a valid invite', contentType: 'text/html' },
      404: { description: 'Unknown invite', contentType: 'text/html' },
      410: {
        description: 'Invite expired or redeemed, or the share has ended',
        contentType: 'text/html',
      },
    },
  }),
);

type Lang = 'de' | 'en';

const TEXT: Record<Lang, Record<InviteState | 'title' | 'open' | 'getApp' | 'noKey', string>> = {
  de: {
    title: 'Einladung zu einem Habit',
    valid:
      'Jemand möchte ein Habit mit dir teilen. Öffne die Einladung in Loop Habit Tracker, um es anzusehen.',
    redeemed: 'Diese Einladung wurde bereits eingelöst. Bitte um eine neue Einladung.',
    expired: 'Diese Einladung ist abgelaufen. Bitte um eine neue Einladung.',
    ended: 'Dieses Habit wird nicht mehr geteilt.',
    unknown: 'Diese Einladung gibt es nicht.',
    open: 'In Loop öffnen',
    getApp: 'Du hast die App noch nicht? Hier gibt es sie:',
    noKey: 'Der Link ist unvollständig: Der Schlüssel fehlt. Kopiere den ganzen Link.',
  },
  en: {
    title: 'Invitation to a habit',
    valid:
      'Someone wants to share a habit with you. Open the invite in Loop Habit Tracker to see it.',
    redeemed: 'This invite has already been redeemed. Ask for a new one.',
    expired: 'This invite has expired. Ask for a new one.',
    ended: 'This habit is no longer shared.',
    unknown: 'This invite does not exist.',
    open: 'Open in Loop',
    getApp: "Don't have the app yet? Get it here:",
    noKey: 'The link is incomplete: the key is missing. Copy the whole link.',
  },
};

const STATUS: Record<InviteState, number> = {
  valid: 200,
  redeemed: 410,
  expired: 410,
  ended: 410,
  unknown: 404,
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(lang: Lang, state: InviteState, code: string, appUrl: string, nonce: string): string {
  const t = TEXT[lang];
  const actions =
    state === 'valid'
      ? `<p id="no-key" hidden>${t.noKey}</p>
    <p><a id="open" class="button" href="#" hidden>${t.open}</a></p>
    <p>${t.getApp} <a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p>
    <script nonce="${nonce}">
      (function () {
        var params = new URLSearchParams(location.hash.slice(1));
        var key = params.get('k');
        if (!key) { document.getElementById('no-key').hidden = false; return; }
        var base = location.href.split('#')[0].replace(/\\/invite\\/[^/?]*([?].*)?$/, '');
        var query = new URLSearchParams({ server: base, code: ${JSON.stringify(code)}, k: key, v: params.get('v') || '1' });
        var link = document.getElementById('open');
        link.href = '${APP_SCHEME}://invite?' + query.toString();
        link.hidden = false;
      })();
    </script>`
      : '';
  return `<!DOCTYPE html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <title>${t.title}</title>
    <style nonce="${nonce}">
      body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
      .button { display: inline-block; padding: .75rem 1.25rem; border-radius: .5rem; background: #2e7d32; color: #fff; text-decoration: none; }
    </style>
  </head>
  <body>
    <h1>${t.title}</h1>
    <p>${t[state]}</p>
    ${actions}
  </body>
</html>
`;
}

export function createInvitePageRouter(shares: ShareService, appUrl: string): Router {
  const router = Router();

  router.get('/invite/:code', (req: Request, res: Response) => {
    const code = String(req.params['code']);
    const state = CODE_PATTERN.test(code) ? shares.inviteState(code) : 'unknown';
    const lang: Lang = req.acceptsLanguages('en', 'de') === 'de' ? 'de' : 'en';
    const nonce = randomBytes(16).toString('base64');
    res
      .status(STATUS[state])
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'Referrer-Policy': 'no-referrer',
        Vary: 'Accept-Language',
      })
      .send(page(lang, state, code, appUrl, nonce));
  });

  return router;
}
