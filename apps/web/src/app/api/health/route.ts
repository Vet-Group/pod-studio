/** Liveness probe for the dev server and Playwright webServer. No database access yet (P1-02). */
export function GET() {
  return Response.json({ ok: true, service: 'pod-studio-web' });
}
