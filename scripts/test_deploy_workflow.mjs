import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-spanish-app.yml', import.meta.url),
  'utf8',
);

assert.match(workflow, /cancel-in-progress:\s*false/);
assert.match(workflow, /id-token:\s*write/);

const promptGate = workflow.indexOf('npm run test:prompt');
const priorCapture = workflow.indexOf('PREVIOUS_REVISION=$(gcloud run services describe');
const deploy = workflow.indexOf('gcloud run deploy "${SERVICE}"');
const revisionLookup = workflow.indexOf('LATEST=$(gcloud run services describe', deploy);
const deployBlock = workflow.slice(deploy, revisionLookup);
const digestCheck = workflow.indexOf('test "${IMAGE_REF}" = "${REV_DIGEST}"', revisionLookup);
const rollbackArm = workflow.indexOf('echo "TRAFFIC_MOVED=1"', digestCheck);
const cutover = workflow.indexOf('gcloud run services update-traffic', rollbackArm);
const publicVerify = workflow.indexOf('- name: Verify exact public bundle', cutover);
const exactShaCheck = workflow.indexOf('test "${LIVE_SHA}" = "${EXPECTED_SHA}"', publicVerify);
const deployVerified = workflow.indexOf('echo "DEPLOY_VERIFIED=1"', exactShaCheck);
const rollback = workflow.indexOf('- name: Roll back unverified traffic', publicVerify);
const rollbackBlock = workflow.slice(rollback);

assert.ok(promptGate >= 0, 'sentence-specific recall prompt test gate is missing');
assert.ok(priorCapture >= 0, 'previous 100% traffic revision capture is missing');
assert.ok(promptGate < deploy, 'recall prompt test must pass before deployment');
assert.ok(deploy > priorCapture, 'previous revision must be captured before deploy');
assert.ok(revisionLookup > deploy, 'latest created revision lookup is missing');
assert.match(deployBlock, /--no-traffic/, 'Cloud Run deploy command must include --no-traffic');
assert.ok(digestCheck > revisionLookup, 'immutable digest must be checked after revision creation');
assert.ok(rollbackArm > digestCheck, 'rollback must be armed after digest verification');
assert.ok(rollbackArm < cutover, 'rollback must be armed before traffic can move');
assert.ok(publicVerify > cutover, 'public bundle must be verified after cutover');
assert.ok(exactShaCheck > publicVerify, 'exact public bundle SHA check is missing');
assert.ok(deployVerified > exactShaCheck, 'DEPLOY_VERIFIED must be set only after exact SHA verification');
assert.ok(rollback > deployVerified, 'rollback step must follow successful public verification');
assert.match(
  rollbackBlock,
  /always\(\).*env\.TRAFFIC_MOVED == '1'.*env\.DEPLOY_VERIFIED != '1'/,
);
assert.match(
  rollbackBlock,
  /--to-revisions\s+"\$\{PREVIOUS_REVISION\}=100"/,
  'rollback must restore the captured revision to 100% traffic',
);
assert.match(
  rollbackBlock,
  /test\s+"\$\{ROLLED_BACK_REV\}"\s+=\s+"\$\{PREVIOUS_REVISION\}"/,
  'rollback must assert that the captured revision was restored',
);
assert.match(
  rollbackBlock,
  /test\s+"\$\{ROLLED_BACK_PERCENT\}"\s+=\s+"100"/,
  'rollback must assert that restored traffic is 100%',
);

console.log('deployment safety contract passed');
