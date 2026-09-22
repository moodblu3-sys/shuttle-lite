export function isLocalMutation(request: Request, header = 'x-shuttle-settings'): boolean {
  try {
    const url = new URL(request.url);
    const host = new URL(`${url.protocol}//${request.headers.get('host') ?? url.host}`);
    const origin = new URL(request.headers.get('origin') ?? '');
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) &&
      origin.origin === host.origin &&
      request.headers.get(header) === '1' &&
      (!request.headers.has('sec-fetch-site') ||
        request.headers.get('sec-fetch-site') === 'same-origin')
    );
  } catch {
    return false;
  }
}
