import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// This test locks the repo-side invariants of Spec 09 R1 (railway.json exact
// content) and R2 (Railpack build/deploy-hygiene constraints), per Spec 01
// R7 test-runner conventions. No relative imports needed — it reads the
// repo-root config files directly, the same files Railpack/Railway read.

const railwayJson = JSON.parse(fs.readFileSync('railway.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

describe('railway.json (Spec 09 R1 / A1)', () => {
  it('has the correct $schema and RAILPACK builder', () => {
    assert.equal(railwayJson.$schema, 'https://railway.com/railway.schema.json');
    assert.equal(railwayJson.build.builder, 'RAILPACK');
  });

  it('has the correct startCommand and healthcheckPath', () => {
    assert.equal(railwayJson.deploy.startCommand, 'node dist/server.js');
    assert.equal(railwayJson.deploy.healthcheckPath, '/health');
  });

  it('has numeric (never string) deploy timing fields with the exact values', () => {
    // findings/07 gotcha 14: docs-page examples show these as strings; the
    // schema types them number — strings are the documented trap.
    assert.equal(typeof railwayJson.deploy.healthcheckTimeout, 'number');
    assert.equal(railwayJson.deploy.healthcheckTimeout, 120);

    assert.equal(typeof railwayJson.deploy.overlapSeconds, 'number');
    assert.equal(railwayJson.deploy.overlapSeconds, 10);

    assert.equal(typeof railwayJson.deploy.drainingSeconds, 'number');
    assert.equal(railwayJson.deploy.drainingSeconds, 60);

    assert.equal(typeof railwayJson.deploy.restartPolicyMaxRetries, 'number');
    assert.equal(railwayJson.deploy.restartPolicyMaxRetries, 3);
  });

  it('has the correct restart policy and region pin', () => {
    assert.equal(railwayJson.deploy.restartPolicyType, 'ON_FAILURE');
    assert.equal(railwayJson.deploy.multiRegionConfig['us-east4-eqdc4a'].numReplicas, 1);
  });
});

describe('repo deploy hygiene (Spec 09 R2 / A10)', () => {
  it('has no Dockerfile at the repo root', () => {
    // findings/07 gotcha 9: a stray Dockerfile silently overrides
    // builder: RAILPACK.
    assert.equal(fs.existsSync('Dockerfile'), false);
  });

  it('package.json pins engines.node and the exact build/start/dev scripts', () => {
    assert.equal(packageJson.engines.node, '22.x');
    assert.equal(packageJson.scripts.build, 'tsc -p tsconfig.json');
    assert.equal(packageJson.scripts.start, 'node dist/server.js');
    assert.equal(packageJson.scripts.dev, 'tsx watch --env-file=.env src/server.ts');
  });

  it('package.json has no preinstall/postinstall scripts', () => {
    // findings/07 §5, gotcha: preinstall/postinstall disable Railpack's
    // install-layer cache.
    assert.equal('preinstall' in packageJson.scripts, false);
    assert.equal('postinstall' in packageJson.scripts, false);
  });
});
