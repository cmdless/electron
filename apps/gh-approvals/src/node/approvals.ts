import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeploymentItem, Environment } from './files.js';

const run = promisify(execFile);

// gh, as the account the token is for - handing gh its token for this one
// command, so gh's active account stays whatever it was
const gh = (token: string, args: string[]) =>
  run('gh', args, { env: { ...process.env, GH_TOKEN: token, GH_HOST: 'github.com' } }).then(({ stdout }) => stdout);

// approves a pull request, as Add review > Approve > Submit does on GitHub
export async function approvePullRequest(token: string, url: string, body: string) {
  await gh(token, ['pr', 'review', url, '--approve', '--body', body]);
}

// approves a run's deployment to one environment, as Review deployments >
// Approve and deploy does on GitHub
export async function approveDeployment(token: string, deployment: DeploymentItem, environment: Environment, comment: string) {
  await gh(token, [
    'api', '-X', 'POST', `repos/${deployment.repo}/actions/runs/${deployment.runId}/pending_deployments`,
    '-F', `environment_ids[]=${environment.id}`, '-f', 'state=approved', '-f', `comment=${comment}`,
  ]);
}
