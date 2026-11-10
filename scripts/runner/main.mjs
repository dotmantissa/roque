import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { MODES, Runner, StopRun } from './runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultConfig = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'roque-run/config.json');
const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'roque-run');
const help = `Usage: ./roque_run [options]

Randomized Sepolia test swaps through https://roque-dex.vercel.app/api.
Defaults: up to 100 Sepolia submissions (setup included), $0.25-$5 per swap,
25% maximum of an available token balance, 1% slippage, 1s between attempts.
Autonomous Confirm and Direct are randomly interleaved with equal weight.

  --dry-run                 Read-only preflight and sample plans; no signing/sends
  --max-txs N               Submission budget, 1-100 (default 100)
  --max-attempts N           Bound interpretation attempts, 1-300 (default 150)
  --min-usd N               Minimum swap notional (default 0.25)
  --max-usd N               Maximum swap notional (default 5)
  --slippage-bps N           Slippage bound, 1-500 (default 100)
  --interval-ms N            Fixed pause between attempts, 0-60000 (default 1000)
  --modes LIST              autonomous-confirm,autonomous-direct
  --api-url URL             Full API base, including /api for the hosted app
  --config PATH             Config file (default ${defaultConfig})
  --require-wallet-latch    Refuse wallet sends without local Latch credentials
  --acknowledge-unresolved  Clear a previous uncertain send AFTER checking chain
  --help                    Show this help

Config keys: privateKey, apiUrl, rpcUrl, latchRpcUrl, latchToken.
Environment overrides: ROQUE_PRIVATE_KEY, ROQUE_API_URL, SEPOLIA_RPC_URL,
LATCH_RPC_URL, LATCH_TOKEN, ROQUE_RUN_CONFIG. Credentials are never logged.
Ctrl-C stops after the current request/receipt. Logs: ${stateDir}/runs/

The limit covers Sepolia sends initiated by this runner, including relayer
grants, approvals, deposits, reverted sends and uncertain submissions. The app
also performs GenLayer interpretation transactions outside that Sepolia budget.
Confirm/Direct use the same API; Confirm adds a logged automated review step.
All swaps and capability grants use the deployed relayer's Latch settings.
Owner-signed vault approvals/deposits use the normal Sepolia RPC unless optional
local Latch credentials are configured. Local Latch credentials are not required.
`;

export function optionsFrom(argv) {
  const { values } = parseArgs({ args: argv, options: {
    help: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'max-txs': { type: 'string' }, 'max-attempts': { type: 'string' },
    'min-usd': { type: 'string' }, 'max-usd': { type: 'string' },
    'slippage-bps': { type: 'string' }, 'interval-ms': { type: 'string' },
    modes: { type: 'string' }, 'api-url': { type: 'string' }, config: { type: 'string' },
    'require-wallet-latch': { type: 'boolean' }, 'acknowledge-unresolved': { type: 'boolean' },
  }, strict: true });
  const number = (name, fallback, low, high, integer = false) => {
    const n = Number(values[name] ?? fallback);
    if (!Number.isFinite(n) || n < low || n > high || (integer && !Number.isInteger(n))) throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} between ${low} and ${high}.`);
    return n;
  };
  const options = {
    maxTxs: number('max-txs', 100, 1, 100, true), maxAttempts: number('max-attempts', 150, 1, 300, true),
    minUsd: number('min-usd', 0.25, 0.000001, 10000), maxUsd: number('max-usd', 5, 0.000001, 10000),
    slippageBps: number('slippage-bps', 100, 1, 500, true), intervalMs: number('interval-ms', 1000, 0, 60000, true),
    modes: [...new Set((values.modes ?? MODES.join(',')).split(','))],
    dryRun: values['dry-run'] ?? false,
  };
  if (options.minUsd > options.maxUsd) throw new Error('--min-usd cannot exceed --max-usd.');
  if (!options.modes.length || options.modes.some(m => !MODES.includes(m))) throw new Error('Only autonomous-confirm and autonomous-direct are supported.');
  return { values, options };
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

export function makeApi(baseUrl, account, fetcher = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('API URL must use HTTPS, or HTTP on localhost.');
  if (base.username || base.password || base.search || base.hash) throw new Error('API URL must not contain credentials, query parameters or a fragment.');
  let session;
  const request = async (path, body, authenticated = false) => {
    if (authenticated) await request.authenticate();
    let response;
    try {
      response = await fetcher(base.href.replace(/\/$/, '') + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'user-agent': 'Roque-Testnet-Runner/1.0',
          ...(authenticated ? { authorization: `Bearer ${session.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000),
      });
    } catch {
      throw new Error(`API request ${path} failed or timed out; it was not retried.`);
    }
    if (!response.ok) throw new Error(`API ${path} returned HTTP ${response.status}; it was not retried.`);
    try { return await response.json(); } catch { throw new Error(`API ${path} returned unreadable JSON.`); }
  };
  request.authenticate = async () => {
    if (session?.expiresAt > Date.now() / 1000 + 60) return;
    const challenge = await request('/auth/challenge', { owner: account.address });
    if (!challenge.challengeId || typeof challenge.message !== 'string' ||
        !challenge.message.startsWith('Roque autonomous access\n') ||
        !challenge.message.toLowerCase().includes(`wallet: ${account.address.toLowerCase()}`) ||
        !challenge.message.includes('Chain ID: 11155111') || challenge.expiresAt <= Date.now() / 1000) {
      throw new Error('App returned an unexpected wallet authentication challenge.');
    }
    const signature = await account.signMessage({ message: challenge.message });
    session = await request('/auth/session', { owner: account.address, challengeId: challenge.challengeId, signature });
    if (!session.token || session.owner?.toLowerCase() !== account.address.toLowerCase() || !(session.expiresAt > Date.now() / 1000)) throw new Error('Invalid wallet authentication session.');
  };
  return request;
}

async function main() {
  const { values, options } = optionsFrom(process.argv.slice(2));
  if (values.help) { process.stdout.write(help); return; }
  const configPath = resolve(values.config || process.env.ROQUE_RUN_CONFIG || defaultConfig);
  if (existsSync(configPath) && (statSync(configPath).mode & 0o077)) throw new Error(`Config permissions are too open. Run: chmod 600 '${configPath}'`);
  const saved = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const config = {
    privateKey: process.env.ROQUE_PRIVATE_KEY || saved.privateKey,
    apiUrl: values['api-url'] || process.env.ROQUE_API_URL || saved.apiUrl || 'https://roque-dex.vercel.app/api',
    rpcUrl: process.env.SEPOLIA_RPC_URL || saved.rpcUrl || 'https://ethereum-sepolia-rpc.publicnode.com',
    latchRpcUrl: process.env.LATCH_RPC_URL || saved.latchRpcUrl || '',
    latchToken: process.env.LATCH_TOKEN || saved.latchToken || '',
  };
  if (!/^(0x)?[\da-f]{64}$/i.test(config.privateKey ?? '')) throw new Error(`Set privateKey in ${configPath}, or ROQUE_PRIVATE_KEY.`);
  if (!!config.latchRpcUrl !== !!config.latchToken) throw new Error('Configure both Latch RPC URL and token, or neither.');
  if (values['require-wallet-latch'] && !config.latchRpcUrl) throw new Error('Local Latch credentials are required by --require-wallet-latch.');
  for (const value of [config.rpcUrl, config.latchRpcUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC URLs must use HTTPS or localhost HTTP.');
  }
  let account;
  try { account = privateKeyToAccount(`0x${config.privateKey.replace(/^0x/i, '')}`); }
  catch { throw new Error('The configured private key is invalid.'); }
  const json = path => JSON.parse(readFileSync(join(root, 'packages/shared/src', path), 'utf8'));
  const deployment = json('deployment.json');
  const tokens = deployment.tokenSymbols.map((symbol, i) => ({ symbol, address: deployment.tokenAddresses[i], decimals: deployment.tokenDecimals[i] }));
  const abis = { token: json('abis/TestToken.json'), executor: json('abis/AgentExecutor.json') };
  const transport = () => http(config.rpcUrl, { timeout: 30_000, retryCount: 1 });
  const publicClient = createPublicClient({ chain: sepolia, transport: transport() });
  const wallet = createWalletClient({ account, chain: sepolia, transport: transport() });
  const writeClient = createPublicClient({ chain: sepolia, transport: http(config.latchRpcUrl || config.rpcUrl, {
    timeout: 30_000, retryCount: 0,
    ...(config.latchRpcUrl ? { fetchOptions: { headers: { authorization: `Bearer ${config.latchToken}` } } } : {}),
  }) });
  const api = makeApi(config.apiUrl, account);
  mkdirSync(join(stateDir, 'runs'), { recursive: true, mode: 0o700 });
  const walletStateDir = join(stateDir, account.address.toLowerCase());
  mkdirSync(walletStateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(walletStateDir, 'run.lock');
  const pendingPath = join(walletStateDir, 'pending.json');
  if (existsSync(lockPath)) {
    const owner = Number(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(owner) || owner <= 0) throw new Error(`Invalid lock file: ${lockPath}`);
    try { process.kill(owner, 0); throw new Error(`Runner PID ${owner} already holds the wallet lock.`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lockPath);
  }
  const lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  closeSync(lock);
  let logFd;
  let runner;
  let signalHandler;
  let journalSafe = true;
  let pending;
  const logPath = join(stateDir, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
  try {
    if (existsSync(pendingPath)) {
      pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
      if (!options.dryRun) {
        const receipt = pending.hash ? await publicClient.getTransactionReceipt({ hash: pending.hash }).catch(() => null) : null;
        if (receipt || values['acknowledge-unresolved']) {
          unlinkSync(pendingPath);
          pending = undefined;
        } else throw new Error(`Previous submission is unresolved (${pending.hash || pending.label}). Check ${pendingPath} and app activity. Use --acknowledge-unresolved only after checking its outcome.`);
      }
    }
    logFd = openSync(logPath, 'ax', 0o600);
    const log = (event, details = {}) => {
      try {
        if (!options.dryRun && event === 'reserved') {
          pending = { ...details, logPath, time: new Date().toISOString() };
          atomicJson(pendingPath, pending);
        }
        if (!options.dryRun && event === 'submitted' && pending) {
          pending = { ...pending, hash: details.hash };
          atomicJson(pendingPath, pending);
        }
        writeFileSync(logFd, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n');
        if (!options.dryRun && event === 'receipt' && existsSync(pendingPath)) {
          unlinkSync(pendingPath);
          pending = undefined;
        }
      } catch {
        journalSafe = false;
        throw new StopRun('Cannot persist the transaction journal. Stopping sends.');
      }
      if (['submitted', 'trade-complete', 'trade-skipped', 'dry-run-plan', 'preflight', 'confirmed', 'stopped'].includes(event)) {
        process.stdout.write(`${event}: ${JSON.stringify(details)}\n`);
      }
    };
    const pause = async ms => { for (let elapsed = 0; elapsed < ms && !runner?.stopping; elapsed += 200) await new Promise(resolve => setTimeout(resolve, Math.min(200, ms - elapsed))); };
    runner = new Runner({ publicClient, wallet, writeClient, account, api, tokens, deployment, abis, chain: sepolia, config, options, log, pause });
    signalHandler = () => { runner.stopping = true; process.stdout.write('Stopping after the current request/receipt...\n'); };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);
    log('run-start', { wallet: account.address, api: config.apiUrl, maxTxs: options.maxTxs, dryRun: options.dryRun, walletRoute: config.latchRpcUrl ? 'latch' : 'rpc', modes: options.modes });
    process.stdout.write(`Roque testnet automation | wallet ${account.address} | max ${options.maxTxs} Sepolia submissions\nLog: ${logPath}\n`);
    if (!config.latchRpcUrl) process.stdout.write('Autonomous swaps/grants: deployed app relayer/Latch configuration. Vault setup only: wallet via standard RPC.\n');
    try { await runner.run(); }
    catch (error) {
      const message = error instanceof StopRun ? error.message : (error.shortMessage || 'Preflight failed. Check app connectivity, RPC connectivity and wallet funding.');
      if (journalSafe) log('stopped', { message });
      else process.stderr.write(message + '\n');
      if (pending || !(error instanceof StopRun) || (runner.budget.used < options.maxTxs && !runner.stopping)) process.exitCode = 1;
    }
    const summary = { budgetUsed: runner.budget.used, completedSwaps: runner.completed, skippedAttempts: runner.failed, modes: runner.modeCounts, unresolvedSubmission: !!pending };
    if (journalSafe) log('summary', summary);
    process.stdout.write(`Finished: ${JSON.stringify(summary)}\n`);
  } finally {
    if (signalHandler) { process.off('SIGINT', signalHandler); process.off('SIGTERM', signalHandler); }
    if (logFd !== undefined) closeSync(logFd);
    unlinkSync(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never print transport exceptions, config objects, signatures or raw txs.
    process.stderr.write(`roque_run: ${error.shortMessage || error.message}\n`);
    process.exitCode = 1;
  });
}
