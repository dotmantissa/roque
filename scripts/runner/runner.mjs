import { randomInt } from 'node:crypto';
import { encodeFunctionData, formatUnits, parseUnits, keccak256 } from 'viem';

export const MODES = ['autonomous-confirm', 'autonomous-direct'];
export class StopRun extends Error {}
export class SkipTrade extends Error {}
export const min = (...values) => values.reduce((a, b) => a < b ? a : b);

// All spend arithmetic stays in integers. Leave a margin below grant ceilings.
export function amountRange(balance, decimals, price, minUsd, maxUsd, ceilingUsd = maxUsd) {
  if (!(price > 0) || !Number.isFinite(price)) return null;
  const scale = 10n ** BigInt(decimals);
  const priceRaw = parseUnits(price.toFixed(8), 8);
  if (!priceRaw) return null;
  const unitsFor = (value, roundUp = false) => {
    const numerator = parseUnits(value.toFixed(8), 8) * scale;
    return (numerator + (roundUp ? priceRaw - 1n : 0n)) / priceRaw;
  };
  const low = unitsFor(minUsd, true) || 1n;
  const high = min(balance / 4n, unitsFor(maxUsd), unitsFor(ceilingUsd));
  return high >= low ? { low, high } : null;
}

export function randomAmount(range, rng = randomInt) {
  return range.low + (range.high - range.low) * BigInt(rng(0, 1_000_001)) / 1_000_000n;
}

export class Budget {
  constructor(limit, log) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('max-txs must be between 1 and 100.');
    this.limit = limit;
    this.used = 0;
    this.log = log;
  }
  require(slots = 1) {
    if (this.used + slots > this.limit) throw new StopRun('Transaction limit reached.');
  }
  reserve(label, details = {}) {
    this.require();
    // Persist before making a request: a lost response can still mean a send.
    this.log('reserved', { number: this.used + 1, label, ...details });
    this.used++;
  }
}

export function assertInterpretation(result, plan) {
  const i = result?.interpretation;
  if (!result?.id || !i?.ok || i.kind !== 'swap' || i.amountIsPercent ||
      i.tokenIn !== plan.from.symbol || i.tokenOut !== plan.to.symbol) {
    throw new SkipTrade('Interpreter did not return the requested exact-input market swap.');
  }
  if (!/^\d+(\.\d+)?$/.test(i.amount) || parseUnits(i.amount, plan.from.decimals) !== plan.raw) {
    throw new SkipTrade('Interpreter changed the requested amount.');
  }
}

export class Runner {
  constructor(deps) {
    Object.assign(this, deps);
    if (!this.options.modes.length || this.options.modes.some(mode => !MODES.includes(mode))) {
      throw new StopRun('Only autonomous-confirm and autonomous-direct are supported.');
    }
    this.budget = new Budget(this.options.maxTxs, this.log);
    this.completed = 0;
    this.failed = 0;
    this.modeCounts = Object.fromEntries(MODES.map(m => [m, 0]));
    this.stopping = false;
  }
  guard() {
    if (this.stopping) throw new StopRun('Stopped by signal.');
  }
  async read(address, abi, functionName, args) {
    return this.publicClient.readContract({ address, abi, functionName, args });
  }
  async snapshot() {
    const contracts = this.tokens.flatMap(t => [
      { address: t.address, abi: this.abis.token, functionName: 'balanceOf', args: [this.account.address] },
      { address: this.deployment.agentExecutor, abi: this.abis.executor, functionName: 'availableBalance', args: [this.account.address, t.address] },
    ]);
    const [raws, price] = await Promise.all([
      this.publicClient.multicall({ contracts, allowFailure: false }),
      this.api('/price'),
    ]);
    return this.tokens.map((token, i) => ({ ...token, wallet: BigInt(raws[i * 2]), vault: BigInt(raws[i * 2 + 1]), price: Number(price.prices[token.symbol]) }));
  }
  async capability() {
    const user = this.account.address;
    const [cap, remaining, nonce] = await Promise.all([
      this.read(this.deployment.agentExecutor, this.abis.executor, 'getCapability', [user]),
      this.read(this.deployment.agentExecutor, this.abis.executor, 'remainingDailyUsd', [user]),
      this.read(this.deployment.agentExecutor, this.abis.executor, 'grantNonce', [user]),
    ]);
    return { ...cap, remaining, nonce };
  }
  async receipt(hash, label) {
    let receipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 3000 });
    } catch {
      throw new StopRun(`Receipt unresolved for ${label}: ${hash}. Check the log and chain before rerunning.`);
    }
    this.log('receipt', { label, hash, status: receipt.status, block: String(receipt.blockNumber) });
    if (receipt.status !== 'success') throw new SkipTrade(`${label} reverted (${hash}).`);
  }
  async localWrite(label, address, abi, functionName, args) {
    this.guard();
    this.budget.require();
    const data = encodeFunctionData({ abi, functionName, args });
    // Prepare and estimate through the read RPC; only the signed send uses Latch.
    const gas = await this.publicClient.estimateGas({ account: this.account.address, to: address, data });
    const nonce = await this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    const request = await this.wallet.prepareTransactionRequest({ account: this.account, chain: this.chain, to: address, data, nonce, gas: gas + gas / 5n });
    const native = await this.publicClient.getBalance({ address: this.account.address });
    if (native < request.gas * (request.maxFeePerGas ?? request.gasPrice)) throw new StopRun('Wallet needs Sepolia ETH for gas.');
    const signed = await this.wallet.signTransaction(request);
    const hash = keccak256(signed);
    this.guard();
    this.budget.reserve(label, { hash, sender: this.account.address, nonce });
    try {
      const returned = await this.writeClient.sendRawTransaction({ serializedTransaction: signed });
      if (returned.toLowerCase() !== hash.toLowerCase()) throw new Error('RPC returned a different transaction hash.');
    } catch {
      throw new StopRun(`Send outcome uncertain for ${label}: ${hash}. No replacement or retry was sent.`);
    }
    this.log('submitted', { label, hash, route: this.config.latchRpcUrl ? 'latch' : 'wallet-rpc' });
    await this.receipt(hash, label);
    return hash;
  }
  async remoteWrite(path, body, label) {
    await this.api.authenticate();
    this.guard();
    this.budget.reserve(label, { intentId: body.id });
    let result;
    try {
      result = await this.api(path, body, true);
    } catch {
      // A server can submit before its HTTP response is lost. Never retry a write.
      throw new StopRun(`${label} did not return a confirmed outcome. Inspect app activity and this run's log before rerunning.`);
    }
    if (!/^0x[\da-f]{64}$/i.test(result.txHash ?? '')) throw new StopRun(`${label} returned no transaction hash.`);
    this.log('submitted', { label, hash: result.txHash, intentId: body.id, route: 'app-relayer' });
    await this.receipt(result.txHash, label);
    return result.txHash;
  }
  async approve(token, spender, needed, reserveFor) {
    const allowed = await this.read(token.address, this.abis.token, 'allowance', [this.account.address, spender]);
    if (allowed >= needed) return;
    this.budget.require(1 + reserveFor);
    // A bounded allowance up to the current wallet balance, never unlimited.
    const limit = min(token.wallet, needed * BigInt(this.options.maxTxs));
    await this.localWrite(`approve ${token.symbol}`, token.address, this.abis.token, 'approve', [spender, limit]);
  }
  async ensureGrant() {
    const cap = await this.capability();
    const valid = !cap.revoked && Number(cap.validUntil) > Date.now() / 1000 + 600 &&
      cap.agentSigner.toLowerCase() === this.agentSigner.toLowerCase() &&
      cap.maxPerTradeUsd > 0n && cap.maxSlippageBps >= BigInt(this.options.slippageBps);
    // Preserve existing live caps, including an exhausted daily allowance.
    if (valid) return;
    this.budget.require(2); // Leave room for at least one trade.
    const message = {
      user: this.account.address, agentSigner: this.agentSigner,
      maxPerTradeUsd: parseUnits(String(this.options.maxUsd), 18),
      maxDailyUsd: parseUnits(String(this.options.maxUsd), 18) * BigInt(this.options.maxTxs),
      maxSlippageBps: BigInt(this.options.slippageBps),
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 86400), grantNonce: cap.nonce,
    };
    const signature = await this.account.signTypedData({
      domain: { name: 'RoqueAgentExecutor', version: '1', chainId: 11155111, verifyingContract: this.deployment.agentExecutor },
      primaryType: 'Grant', types: { Grant: [
        { name: 'user', type: 'address' }, { name: 'agentSigner', type: 'address' },
        { name: 'maxPerTradeUsd', type: 'uint256' }, { name: 'maxDailyUsd', type: 'uint256' },
        { name: 'maxSlippageBps', type: 'uint256' }, { name: 'validUntil', type: 'uint64' },
        { name: 'grantNonce', type: 'uint256' },
      ] }, message,
    });
    const body = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'grantNonce').map(([key, value]) => [key, String(value)]));
    await this.remoteWrite('/grant', { ...body, signature }, 'grant capability');
  }
  async bootstrapVault(snapshot) {
    if (snapshot.some(t => amountRange(t.vault, t.decimals, t.price, this.options.minUsd, this.options.maxUsd))) return false;
    const candidates = snapshot.filter(t => amountRange(t.wallet, t.decimals, t.price, this.options.minUsd * 8, this.options.maxUsd * 10));
    if (!candidates.length) return false;
    this.budget.require(3); // Deposit, possible approval, and a trade.
    const token = candidates[randomInt(candidates.length)];
    const range = amountRange(token.wallet, token.decimals, token.price, this.options.minUsd * 8, this.options.maxUsd * 10);
    const amount = range.high;
    await this.approve(token, this.deployment.agentExecutor, amount, 2);
    await this.localWrite(`deposit ${token.symbol}`, this.deployment.agentExecutor, this.abis.executor, 'deposit', [token.address, amount]);
    return true;
  }
  choosePlan(mode, snapshot, cap) {
    if (!MODES.includes(mode)) throw new StopRun('Only autonomous-confirm and autonomous-direct are supported.');
    const ceiling = Math.min(Number(formatUnits(cap.maxPerTradeUsd, 18)), Number(formatUnits(cap.remaining, 18))) * 0.95;
    const choices = snapshot.flatMap(token => {
      const range = amountRange(token.vault, token.decimals, token.price, this.options.minUsd, this.options.maxUsd, ceiling);
      return range ? [{ token, range }] : [];
    });
    if (!choices.length) return null;
    const { token: from, range } = choices[randomInt(choices.length)];
    const others = snapshot.filter(t => t.symbol !== from.symbol);
    const to = others[randomInt(others.length)];
    const raw = randomAmount(range);
    return { mode, from, to, raw, amount: formatUnits(raw, from.decimals) };
  }
  async trade(plan) {
    if (!MODES.includes(plan.mode)) throw new StopRun('Only autonomous-confirm and autonomous-direct are supported.');
    const commands = [
      `Swap ${plan.amount} ${plan.from.symbol} for ${plan.to.symbol}`,
      `Exchange ${plan.amount} ${plan.from.symbol} into ${plan.to.symbol}`,
      `Sell ${plan.amount} ${plan.from.symbol} for ${plan.to.symbol} now`,
    ];
    this.guard();
    const command = commands[randomInt(commands.length)];
    this.log('intent-request', { mode: plan.mode, command });
    const result = await this.api('/interpret', { command, mode: 'autonomous', user: this.account.address }, true);
    this.guard();
    this.log('interpreted', { id: result.id, mode: plan.mode });
    assertInterpretation(result, plan);
    // Confirm models the frontend's reviewed-card path. Both modes validate the
    // interpretation before sending; Direct calls execute immediately after it.
    if (plan.mode === 'autonomous-confirm') this.log('confirmed', { id: result.id, amount: plan.amount, from: plan.from.symbol, to: plan.to.symbol });
    const hash = await this.remoteWrite('/execute', { id: result.id, user: this.account.address, slippageBps: this.options.slippageBps }, plan.mode);
    this.completed++;
    this.modeCounts[plan.mode]++;
    this.log('trade-complete', { mode: plan.mode, hash, amount: plan.amount, from: plan.from.symbol, to: plan.to.symbol });
  }
  async run() {
    if (await this.publicClient.getChainId() !== 11155111 || Number(this.deployment.chainId) !== 11155111) throw new StopRun('Only Ethereum Sepolia (11155111) is supported.');
    const agent = await this.api('/agent');
    this.agentSigner = agent.agentSigner;
    if (this.agentSigner?.toLowerCase() !== this.deployment.agentSigner.toLowerCase()) throw new StopRun('Deployed app agent signer differs from the local deployment.');
    for (const address of [this.deployment.router, this.deployment.agentExecutor]) {
      const code = await this.publicClient.getCode({ address });
      if (!code || code === '0x') throw new StopRun(`No deployed contract at ${address}.`);
    }
    const pending = await this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    const latest = await this.publicClient.getTransactionCount({ address: this.account.address, blockTag: 'latest' });
    if (pending !== latest) throw new StopRun('This wallet has pending transactions. Wait for them before running.');
    const initial = await this.snapshot();
    const native = await this.publicClient.getBalance({ address: this.account.address });
    this.log('preflight', { wallet: this.account.address, gasEth: formatUnits(native, 18), tokens: initial.map(t => ({ symbol: t.symbol, wallet: formatUnits(t.wallet, t.decimals), vaultFree: formatUnits(t.vault, t.decimals) })) });
    if (this.options.dryRun) {
      const cap = await this.capability();
      for (const mode of this.options.modes) {
        const plan = this.choosePlan(mode, initial, cap);
        this.log('dry-run-plan', plan ? { mode, from: plan.from.symbol, to: plan.to.symbol, amount: plan.amount } : { mode, setupNeeded: true });
      }
      return;
    }
    await this.ensureGrant();
    const cap = await this.capability();
    if (cap.remaining >= parseUnits(String(this.options.minUsd), 18)) await this.bootstrapVault(initial);
    let failures = 0;
    let bag = [];
    for (let attempt = 0; attempt < this.options.maxAttempts; attempt++) {
      this.guard();
      this.budget.require();
      const [snapshot, cap] = await Promise.all([this.snapshot(), this.capability()]);
      if (!bag.length) bag = [...this.options.modes];
      const plans = bag.map(mode => this.choosePlan(mode, snapshot, cap));
      const eligible = plans.map((p, i) => p ? i : -1).filter(i => i >= 0);
      if (!eligible.length) {
        // Some modes may have run out of funds while others remain available.
        const alternatives = this.options.modes.map(mode => this.choosePlan(mode, snapshot, cap)).filter(Boolean);
        if (!alternatives.length) throw new StopRun('No eligible funded swaps remain within the configured sizes and daily cap.');
        bag = alternatives.map(p => p.mode);
        continue;
      }
      const index = eligible[randomInt(eligible.length)];
      const plan = plans[index];
      bag.splice(index, 1);
      try {
        await this.trade(plan);
        failures = 0;
      } catch (error) {
        if (error instanceof StopRun) throw error;
        this.failed++;
        this.log('trade-skipped', { mode: plan.mode, message: error.shortMessage ?? error.message });
        if (++failures >= 5) throw new StopRun('Stopped after five consecutive unsuccessful trades.');
      }
      await this.pause(this.options.intervalMs);
    }
    this.log('attempt-limit', { limit: this.options.maxAttempts });
  }
}
