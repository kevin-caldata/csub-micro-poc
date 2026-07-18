import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// This test locks the repo-side invariants of Spec 09 R1 (railway.json exact
// content) and R2 (Railpack build/deploy-hygiene constraints), per Spec 01
// R7 test-runner conventions. No relative imports needed — it reads the
// repo-root config files directly, the same files Railpack/Railway read.

const railwayJson = JSON.parse(fs.readFileSync('railway.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

describe('railway.json (Spec 09 R1 / A1)', () => {
  it('has the correct $schema and RAILPACK builder', () => {
    expect(railwayJson.$schema).toBe('https://railway.com/railway.schema.json');
    expect(railwayJson.build.builder).toBe('RAILPACK');
  });

  it('has the correct startCommand and healthcheckPath', () => {
    expect(railwayJson.deploy.startCommand).toBe('node dist/server.js');
    expect(railwayJson.deploy.healthcheckPath).toBe('/health');
  });

  it('has numeric (never string) deploy timing fields with the exact values', () => {
    // findings/07 gotcha 14: docs-page examples show these as strings; the
    // schema types them number — strings are the documented trap.
    expect(typeof railwayJson.deploy.healthcheckTimeout).toBe('number');
    expect(railwayJson.deploy.healthcheckTimeout).toBe(120);

    expect(typeof railwayJson.deploy.overlapSeconds).toBe('number');
    expect(railwayJson.deploy.overlapSeconds).toBe(10);

    expect(typeof railwayJson.deploy.drainingSeconds).toBe('number');
    expect(railwayJson.deploy.drainingSeconds).toBe(60);

    expect(typeof railwayJson.deploy.restartPolicyMaxRetries).toBe('number');
    expect(railwayJson.deploy.restartPolicyMaxRetries).toBe(3);
  });

  it('has the correct restart policy and region pin', () => {
    expect(railwayJson.deploy.restartPolicyType).toBe('ON_FAILURE');
    expect(railwayJson.deploy.multiRegionConfig['us-east4-eqdc4a'].numReplicas).toBe(1);
  });
});

describe('repo deploy hygiene (Spec 09 R2 / A10)', () => {
  it('has no Dockerfile at the repo root', () => {
    // findings/07 gotcha 9: a stray Dockerfile silently overrides
    // builder: RAILPACK.
    expect(fs.existsSync('Dockerfile')).toBe(false);
  });

  it('package.json pins engines.node and the exact build/start/dev scripts', () => {
    expect(packageJson.engines.node).toBe('22.x');
    expect(packageJson.scripts.build).toBe('tsc -p tsconfig.json');
    expect(packageJson.scripts.start).toBe('node dist/server.js');
    expect(packageJson.scripts.dev).toBe('tsx watch --env-file=.env src/server.ts');
  });

  it('package.json has no preinstall/postinstall scripts', () => {
    // findings/07 §5, gotcha: preinstall/postinstall disable Railpack's
    // install-layer cache.
    expect('preinstall' in packageJson.scripts).toBe(false);
    expect('postinstall' in packageJson.scripts).toBe(false);
  });
});
