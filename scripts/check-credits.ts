// scripts/check-credits.ts
//
// Standalone cost-tracking helper (Spec 09 R10.2). Prints one JSON line with
// the current AI Gateway credit balance and total spend, so it can be run
// before/after every milestone test batch and diffed for a spend delta.
//
// Deliberately does NOT import anything from src/ (not even src/config.ts):
// this script must work without PUBLIC_HOST/TWILIO_AUTH_TOKEN, which the
// project's fail-fast config loader would otherwise require.
//
// Usage: npx tsx --env-file=.env scripts/check-credits.ts
//
// `/v1/report` is 403-gated on the Hobby plan (findings/01 gotcha 14), so
// credits-delta (this script, run before/after a test batch) is the
// plan-proof cost-measurement procedure (Spec 09 R10.1).

if (!process.env.AI_GATEWAY_API_KEY || process.env.AI_GATEWAY_API_KEY.trim() === '') {
  console.error(
    'AI_GATEWAY_API_KEY is not set. Without it, @ai-sdk/gateway falls back to ' +
      'Vercel OIDC, which throws a confusing off-Vercel authentication error ' +
      '(findings/01 gotcha 5; Spec 09 R3.4). Set AI_GATEWAY_API_KEY (Vercel ' +
      'dashboard -> AI Gateway -> API Keys) in your .env and re-run with ' +
      '--env-file=.env.',
  );
  process.exit(1);
}

const { gateway } = await import('@ai-sdk/gateway');

try {
  const { balance, totalUsed } = await gateway.getCredits();
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), balance, totalUsed }) + '\n',
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
