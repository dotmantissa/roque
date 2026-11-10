import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget, Runner, StopRun, SkipTrade, amountRange, randomAmount, assertInterpretation } from './runner.mjs';
import { makeApi, optionsFrom } from './main.mjs';
import { keccak256, parseUnits, parseAbi, createWalletClient, custom, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const user = '0x1111111111111111111111111111111111111111';
const agent = '0x2222222222222222222222222222222222222222';
const router = '0x3333333333333333333333333333333333333333';
const executor = '0x4444444444444444444444444444444444444444';
const tokens = [
  { symbol: 'rUSDC', address: '0x5555555555555555555555555555555555555555', decimals: 6 },
  { symbol: 'rWETH', address: '0x6666666666666666666666666666666666666666', decimals: 18 },
];
const hash = `0x${'ab'.repeat(32)}`;
const options = optionsFrom([]).options;
const cap = { agentSigner: agent, revoked: false, validUntil: BigInt(Math.floor(Date.now() / 1000) + 86400), maxPerTradeUsd: parseUnits('5', 18), maxDailyUsd: parseUnits('500', 18), remaining: parseUnits('500', 18), maxSlippageBps: 100n, nonce: 0n };

function fixture(overrides = {}) {
  const events = [];
  const calls = [];
  const publicClient = {
    getChainId: async () => 11155111,
    getCode: async () => '0x1234',
    getTransactionCount: async () => 0,
    getBalance: async () => parseUnits('1', 18),
    estimateGas: async () => 50000n,
    getBlock: async () => ({ timestamp: 1700000000n }),
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }),
    multicall: async () => [100_000000n, 100_000000n, parseUnits('1', 18), parseUnits('1', 18)],
    readContract: async ({ functionName }) => {
      if (functionName === 'getCapability') return cap;
      if (functionName === 'remainingDailyUsd') return cap.remaining;
      if (functionName === 'grantNonce') return 0n;
      if (functionName === 'allowance') return parseUnits('1000000', 18);
      throw new Error(`Unexpected read: ${functionName}`);
    },
  };
  const api = async (path, body, auth) => {
    calls.push({ path, body, auth });
    if (path === '/agent') return { agentSigner: agent };
    if (path === '/price') return { prices: { rUSDC: 1, rWETH: 2000 } };
    if (path === '/execute' || path === '/grant') return { txHash: hash };
    throw new Error(`Unexpected API call: ${path}`);
  };
  api.authenticate = async () => {};
  const runner = new Runner({ publicClient, api, account: { address: user }, tokens,
    deployment: { router, agentExecutor: executor, agentSigner: agent, chainId: 11155111 },
    abis: {}, config: {}, options: { ...options }, chain: {},
    wallet: { prepareTransactionRequest: async args => ({ ...args, maxFeePerGas: 1n }), signTransaction: async () => '0x1234' },
    writeClient: { sendRawTransaction: async () => keccak256('0x1234') },
    log: (event, data) => events.push({ event, ...data }), pause: async () => {}, ...overrides,
  });
  runner.agentSigner = agent;
  return { runner, calls, events, publicClient };
}

test('budget enforces 100 across all categories, counting uncertain reservations', () => {
  const entries = [];
  const b = new Budget(100, (...entry) => entries.push(entry));
  for (let i = 0; i < 100; i++) b.reserve(['approval', 'deposit', 'grant', 'swap'][i % 4]);
  assert.equal(b.used, 100);
  assert.throws(() => b.reserve('101st'), StopRun);
  assert.equal(entries.length, 100);
  assert.throws(() => new Budget(101, () => {}));
  assert.throws(() => new Budget(0, () => {}));
});

test('journal failure prevents reservation', () => {
  const b = new Budget(1, () => { throw new Error('disk full'); });
  assert.throws(() => b.reserve('swap'), /disk full/);
  assert.equal(b.used, 0);
});

test('random sizes honor token decimals, balance fraction, USD sizes and caps', () => {
  for (const decimals of [6, 8, 18]) {
    for (const price of [0.1761575, 1, 2366.71, 81290.97654154]) {
      const balance = 10n ** BigInt(decimals) * 10_000n;
      const range = amountRange(balance, decimals, price, 0.25, 5, 2);
      assert.ok(range);
      for (const raw of [range.low, range.high, ...Array.from({ length: 50 }, () => randomAmount(range))]) {
        assert.ok(raw >= range.low && raw <= range.high);
        assert.ok(raw <= balance / 4n);
        const usd = Number(raw) / 10 ** decimals * price;
        assert.ok(usd >= 0.249 && usd <= 2.000001);
      }
      assert.equal(randomAmount(range, () => 0), range.low);
      assert.equal(randomAmount(range, () => 1_000_000), range.high);
    }
  }
  assert.equal(amountRange(0n, 6, 1, 0.25, 5), null);
  assert.equal(amountRange(10n ** 20n, 18, NaN, 0.25, 5), null);
  assert.equal(amountRange(10n ** 20n, 18, 1, 0.25, 5, 0), null);
});

test('CLI defaults to autonomous only and rejects Copilot, excess budgets, unknown modes, invalid amounts and flags', () => {
  assert.deepEqual(optionsFrom([]).options.modes, ['autonomous-confirm', 'autonomous-direct']);
  for (const args of [['--max-txs', '101'], ['--max-txs', '1.5'], ['--modes', 'bogus'], ['--modes', 'copilot'], ['--modes', 'autonomous-direct,copilot'], ['--min-usd', '6', '--max-usd', '5'], ['--interval-ms', '-1'], ['--unknown']]) {
    assert.throws(() => optionsFrom(args));
  }
  assert.equal(optionsFrom(['--max-txs', '2']).options.maxTxs, 2);
});

const plan = { mode: 'autonomous-direct', from: tokens[0], to: tokens[1], raw: 1_000000n, amount: '1' };
const result = { id: 'intent-1', interpretation: { ok: true, kind: 'swap', tokenIn: 'rUSDC', tokenOut: 'rWETH', amount: '1', amountIsPercent: false } };

test('interpreter results cannot silently change pair, amount, percentage or order type', () => {
  assert.doesNotThrow(() => assertInterpretation(result, plan));
  for (const patch of [{ amount: '2' }, { amount: '1e0' }, { tokenOut: 'rUSDC' }, { kind: 'limit' }, { amountIsPercent: true }, { ok: false }]) {
    assert.throws(() => assertInterpretation({ ...result, interpretation: { ...result.interpretation, ...patch } }, plan), SkipTrade);
  }
});

test('dry-run only reads: no authentication, signatures, interpretation, or broadcasts', async () => {
  const { runner, calls, events } = fixture({ options: { ...options, dryRun: true } });
  runner.api.authenticate = async () => assert.fail('dry-run authenticated');
  runner.localWrite = async () => assert.fail('dry-run sent');
  runner.remoteWrite = async () => assert.fail('dry-run sent');
  await runner.run();
  assert.ok(calls.every(c => c.body === undefined));
  assert.deepEqual(events.filter(e => e.event === 'dry-run-plan').map(e => e.mode), ['autonomous-confirm', 'autonomous-direct']);
  assert.equal(runner.budget.used, 0);
});

test('wrong chain, deployment mismatch and pending transactions stop before any write', async () => {
  for (const problem of ['chain', 'agent', 'pending']) {
    const { runner, publicClient } = fixture();
    if (problem === 'chain') publicClient.getChainId = async () => 1;
    if (problem === 'agent') runner.deployment.agentSigner = user;
    if (problem === 'pending') publicClient.getTransactionCount = async ({ blockTag }) => blockTag === 'pending' ? 1 : 0;
    await assert.rejects(runner.run(), StopRun);
    assert.equal(runner.budget.used, 0);
  }
});

test('Confirm and Direct authenticate, interpret and execute through the same API', async () => {
  for (const mode of ['autonomous-confirm', 'autonomous-direct']) {
    const { runner, events, calls } = fixture();
    const base = runner.api;
    runner.api = Object.assign(async (path, body, auth) => path === '/interpret' ? (calls.push({ path, body, auth }), result) : base(path, body, auth), { authenticate: base.authenticate });
    await runner.trade({ ...plan, mode });
    assert.deepEqual(calls.map(c => c.path), ['/interpret', '/execute']);
    assert.equal(calls[0].body.mode, 'autonomous');
    assert.equal(calls[0].auth, true);
    assert.equal(events.some(e => e.event === 'confirmed'), mode.endsWith('confirm'));
    assert.equal(runner.completed, 1);
    assert.equal(runner.budget.used, 1);
  }
});

test('incorrect interpretation never reaches execute', async () => {
  const { runner } = fixture();
  runner.api = async () => ({ ...result, interpretation: { ...result.interpretation, amount: '10' } });
  await assert.rejects(runner.trade(plan), SkipTrade);
  assert.equal(runner.budget.used, 0);
});

test('remote errors are not retried and still consume one submission slot', async () => {
  const { runner } = fixture();
  let requests = 0;
  runner.api = Object.assign(async () => { requests++; throw new Error('timeout'); }, { authenticate: async () => {} });
  await assert.rejects(runner.remoteWrite('/execute', { id: '1' }, 'swap'), StopRun);
  assert.equal(requests, 1);
  assert.equal(runner.budget.used, 1);
});

test('setup cannot exceed remaining budget', async () => {
  const { runner } = fixture({ options: { ...options, maxTxs: 1 } });
  runner.read = async () => 0n;
  await assert.rejects(runner.approve({ ...tokens[0], wallet: 100_000000n }, router, 1_000000n, 1), StopRun);
  assert.equal(runner.budget.used, 0);
});

test('API challenge authenticates owner, caches session and does not retry writes', async () => {
  const calls = [];
  let signed = 0;
  const now = Math.floor(Date.now() / 1000);
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const body = url.endsWith('/auth/challenge') ? { challengeId: 'challenge', expiresAt: now + 300, message: `Roque autonomous access\n\nWallet: ${user}\nChain ID: 11155111` }
      : url.endsWith('/auth/session') ? { token: 'test-session', owner: user, expiresAt: now + 3600 } : { txHash: hash };
    return { ok: true, json: async () => body };
  };
  const api = makeApi('https://example.com/api', { address: user, signMessage: async () => { signed++; return '0xab'; } }, fetcher);
  await api('/execute', { id: '1' }, true);
  await api('/execute', { id: '2' }, true);
  assert.equal(signed, 1);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].init.headers.authorization, 'Bearer test-session');
  assert.equal(calls[2].init.headers['user-agent'], 'Roque-Testnet-Runner/1.0');
  assert.equal(calls[2].init.redirect, 'error');
  let badCalls = 0;
  const bad = makeApi('https://example.com/api', {}, async () => { badCalls++; return { ok: false, status: 504 }; });
  await assert.rejects(bad('/execute', { id: '1' }), /HTTP 504/);
  assert.equal(badCalls, 1);
});

test('API refuses insecure remote endpoints and unexpected challenges', async () => {
  assert.throws(() => makeApi('http://example.com/api', {}), /HTTPS/);
  assert.throws(() => makeApi('https://secret@example.com/api', {}), /credentials/);
  const api = makeApi('https://example.com/api', { address: user, signMessage: async () => assert.fail('signed invalid challenge') }, async () => ({ ok: true, json: async () => ({ message: 'Sign anything' }) }));
  await assert.rejects(api.authenticate(), /unexpected/);
});

const approveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

test('real viem signing sends only the signed transaction via the write client and shares the cap', async () => {
  // Public deterministic test fixture key; never the user's configured wallet.
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  const rpcReads = [];
  const wallet = createWalletClient({ account, chain: sepolia, transport: custom({
    request: async ({ method }) => { rpcReads.push(method); assert.equal(method, 'eth_chainId'); return '0xaa36a7'; },
  }) });
  wallet.prepareTransactionRequest = async args => ({ ...args, chainId: 11155111, type: 'eip1559', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  let sends = 0;
  const { runner, events } = fixture({ account, wallet, chain: sepolia, options: { ...options, maxTxs: 2 },
    writeClient: { sendRawTransaction: async ({ serializedTransaction }) => {
      sends++;
      const decoded = parseTransaction(serializedTransaction);
      assert.equal(decoded.chainId, 11155111);
      assert.equal(decoded.to.toLowerCase(), tokens[0].address.toLowerCase());
      assert.equal((await recoverTransactionAddress({ serializedTransaction })).toLowerCase(), account.address.toLowerCase());
      assert.ok(events.some(e => e.event === 'reserved' && e.hash === keccak256(serializedTransaction)));
      return keccak256(serializedTransaction);
    } },
  });
  await runner.localWrite('approve', tokens[0].address, approveAbi, 'approve', [router, 100n]);
  await runner.remoteWrite('/execute', { id: 'last' }, 'autonomous');
  await assert.rejects(runner.localWrite('over budget', tokens[0].address, approveAbi, 'approve', [router, 1n]), StopRun);
  await assert.rejects(runner.remoteWrite('/execute', { id: 'extra' }, 'autonomous'), StopRun);
  assert.equal(sends, 1);
  assert.equal(runner.budget.used, 2);
  assert.deepEqual(rpcReads, ['eth_chainId']);
  assert.ok(events.every(e => !JSON.stringify(e).includes('serializedTransaction')));
});

test('a lost local send response records its known hash, consumes a slot and never retries', async () => {
  const { runner, events } = fixture();
  let sends = 0;
  runner.writeClient.sendRawTransaction = async () => { sends++; throw new Error('lost response'); };
  await assert.rejects(runner.localWrite('approve', tokens[0].address, approveAbi, 'approve', [router, 1n]), /outcome uncertain/);
  assert.equal(sends, 1);
  assert.equal(runner.budget.used, 1);
  assert.equal(events[0].event, 'reserved');
  assert.equal(events[0].hash, keccak256('0x1234'));
});

test('insufficient gas and a stop signal prevent a local submission', async () => {
  for (const stop of [false, true]) {
    const { runner, publicClient } = fixture();
    runner.stopping = stop;
    publicClient.getBalance = async () => 0n;
    runner.writeClient.sendRawTransaction = async () => assert.fail('sent despite stop/gas');
    await assert.rejects(runner.localWrite('approve', tokens[0].address, approveAbi, 'approve', [router, 1n]), StopRun);
    assert.equal(runner.budget.used, 0);
  }
});

test('reverted receipts are recorded; unresolved receipts stop the run', async () => {
  const { runner, publicClient, events } = fixture();
  publicClient.waitForTransactionReceipt = async () => ({ status: 'reverted', blockNumber: 1n });
  await assert.rejects(runner.receipt(hash, 'test'), SkipTrade);
  assert.equal(events[0].status, 'reverted');
  publicClient.waitForTransactionReceipt = async () => { throw new Error('timeout'); };
  await assert.rejects(runner.receipt(hash, 'test'), StopRun);
});

test('Copilot is rejected at construction, planning and execution before any request', async () => {
  assert.throws(() => fixture({ options: { ...options, modes: ['copilot'] } }), StopRun);
  const { runner, calls } = fixture();
  assert.throws(() => runner.choosePlan('copilot', [], cap), StopRun);
  await assert.rejects(runner.trade({ ...plan, mode: 'copilot' }), StopRun);
  assert.equal(calls.length, 0);
  assert.equal(runner.budget.used, 0);
});

test('a full 100-swap run uses only authenticated autonomous APIs and both modes without wallet swaps', async () => {
  const { runner, calls } = fixture();
  const base = runner.api;
  runner.api = Object.assign(async (path, body, auth) => {
    if (path === '/interpret') {
      calls.push({ path, body, auth });
      const match = /^(?:Swap|Exchange|Sell) ([0-9.]+) (r\w+) (?:for|into) (r\w+)/.exec(body.command);
      assert.ok(match);
      return { id: `intent-${runner.completed}`, interpretation: { ...result.interpretation, amount: match[1], tokenIn: match[2], tokenOut: match[3] } };
    }
    return base(path, body, auth);
  }, { authenticate: base.authenticate });
  runner.localWrite = async () => assert.fail('funded autonomous run sent a wallet transaction');
  await assert.rejects(runner.run(), /Transaction limit reached/);
  assert.equal(runner.completed, 100);
  assert.equal(runner.budget.used, 100);
  assert.deepEqual(runner.modeCounts, { 'autonomous-confirm': 50, 'autonomous-direct': 50 });
  const interpretations = calls.filter(call => call.path === '/interpret');
  const executions = calls.filter(call => call.path === '/execute');
  assert.equal(interpretations.length, 100);
  assert.equal(executions.length, 100);
  assert.ok(interpretations.every(call => call.auth === true && call.body.mode === 'autonomous'));
  assert.ok(executions.every(call => call.auth === true));
  assert.ok(calls.every(call => !call.path.startsWith('/swap/')));
});

test('live existing grants including exhausted daily caps are preserved', async () => {
  const { runner } = fixture();
  runner.capability = async () => ({ ...cap, remaining: 0n });
  runner.remoteWrite = async () => assert.fail('reset live grant');
  await runner.ensureGrant();
  const initial = await runner.snapshot();
  assert.equal(runner.choosePlan('autonomous-direct', initial, { ...cap, remaining: 0n }), null);
  assert.equal(runner.choosePlan('autonomous-confirm', initial, { ...cap, remaining: 0n }), null);
  const walletOnly = initial.map(token => ({ ...token, vault: 0n }));
  assert.equal(runner.choosePlan('autonomous-direct', walletOnly, cap), null);
});

test('new grant signature binds the wallet, correct chain/domain, scaled limits and current nonce', async () => {
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  let typed;
  let submitted;
  const { runner } = fixture({ account: { ...account, signTypedData: async data => { typed = data; return account.signTypedData(data); } } });
  runner.capability = async () => ({ ...cap, revoked: true, nonce: 7n });
  runner.remoteWrite = async (path, body) => { assert.equal(path, '/grant'); submitted = body; return hash; };
  await runner.ensureGrant();
  assert.equal(typed.domain.chainId, 11155111);
  assert.equal(typed.domain.verifyingContract, executor);
  assert.equal(typed.message.grantNonce, 7n);
  assert.equal(submitted.maxPerTradeUsd, parseUnits('5', 18).toString());
  assert.equal(submitted.maxDailyUsd, parseUnits('500', 18).toString());
  assert.equal(submitted.maxSlippageBps, '100');
  assert.equal(submitted.grantNonce, undefined);
  assert.equal((await recoverTypedDataAddress({ ...typed, signature: submitted.signature })).toLowerCase(), account.address.toLowerCase());
});

test('empty vault bootstraps with a bounded wallet deposit and budget room for a trade', async () => {
  const { runner } = fixture();
  const snapshot = (await runner.snapshot()).map(t => ({ ...t, vault: 0n }));
  let deposit;
  runner.approve = async (token, spender, amount, reserveFor) => {
    assert.equal(spender, executor);
    assert.ok(amount <= token.wallet / 4n);
    assert.equal(reserveFor, 2);
  };
  runner.localWrite = async (label, address, abi, name, args) => {
    assert.equal(address, executor);
    assert.equal(name, 'deposit');
    deposit = args;
    runner.budget.reserve(label);
    return hash;
  };
  assert.equal(await runner.bootstrapVault(snapshot), true);
  assert.ok(deposit[1] > 0n);
  assert.equal(runner.budget.used, 1);
  const small = fixture({ options: { ...options, maxTxs: 2 } }).runner;
  await assert.rejects(small.bootstrapVault(snapshot), StopRun);
});
