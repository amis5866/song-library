import { next } from '@vercel/edge';

export const config = {
  matcher: '/((?!_vercel|favicon\\.ico).*)',
};

export default function middleware(request: Request): Response {
  const authHeader = request.headers.get('authorization');

  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded  = atob(authHeader.slice(6));
      const colon    = decoded.indexOf(':');
      if (colon !== -1) {
        const user         = decoded.substring(0, colon);
        const pass         = decoded.substring(colon + 1);
        const expectedUser = process.env.AUTH_USER ?? '';
        const expectedPass = process.env.AUTH_PASS ?? '';
        if (expectedUser && expectedPass && user === expectedUser && pass === expectedPass) {
          return next();
        }
      }
    } catch {}
  }

  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Song Library", charset="UTF-8"',
    },
  });
}
