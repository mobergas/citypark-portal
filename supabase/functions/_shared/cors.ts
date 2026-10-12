// Browsers only accept a cross-origin response when Access-Control-Allow-Origin matches the
// calling page's own origin, and that header can only hold one value — so the response has
// to echo the request's Origin back, but only when it's one of our own sites. Anything else
// (including requests with no Origin, like Stripe's webhook) gets the primary origin, which
// no other website can use. Add a new white-label subdomain here when one goes live.
const ALLOWED_ORIGINS = new Set([
  'https://www.cityparkmanagement.app',
  'https://cityparkmanagement.app',
  'https://sliplink.cityparkmanagement.app',
]);
const PRIMARY_ORIGIN = 'https://www.cityparkmanagement.app';

export function withCors(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const res = await handler(req);
    const origin = req.headers.get('origin') ?? '';
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : PRIMARY_ORIGIN);
    headers.append('Vary', 'Origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
