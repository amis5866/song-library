import { next } from '@vercel/edge';

export const config = {
  matcher: '/(.*)',
};

export default function middleware(request: Request): Response {
  const authHeader = request.headers.get('authorization');

  if (authHeader && authHeader.startsWith('Basic ')) {
    try {
      const decoded = atob(authHeader.slice(6));
      const colon   = decoded.indexOf(':');
      if (colon !== -1) {
        const user = decoded.substring(0, colon);
        const pass = decoded.substring(colon + 1);
        if (
          user === (process.env.AUTH_USER ?? '') &&
          pass === (process.env.AUTH_PASS ?? '')
        ) {
          return next();
        }
      }
    } catch {}
  }

  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Song Library"',
    },
  });
}
