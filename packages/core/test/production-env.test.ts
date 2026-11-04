import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {serverEnv} from '../src/env.js';
const a='11'.repeat(32),b='22'.repeat(32);
beforeEach(()=>{vi.stubEnv('NODE_ENV','production');vi.stubEnv('LATCH_RPC_URL','https://latch.example');vi.stubEnv('LATCH_TOKEN','test-only-provider-token');vi.stubEnv('AGENT_SIGNER_PRIVATE_KEY','0x'+a);vi.stubEnv('RELAYER_PRIVATE_KEY','0x'+b);vi.stubEnv('DEPLOYER_PRIVATE_KEY','33'.repeat(32));vi.stubEnv('CRON_SECRET','test-only-strong-scheduler-credential');vi.stubEnv('DATABASE_URL','postgresql://test:test@localhost/test');});
afterEach(()=>vi.unstubAllEnvs());
it('rejects an administrator reused with a different key prefix',()=>{vi.stubEnv('DEPLOYER_PRIVATE_KEY',b);expect(()=>serverEnv()).toThrow('dedicated relayer');});
it('rejects missing production Latch and weak scheduler credentials',()=>{vi.stubEnv('LATCH_TOKEN','');expect(()=>serverEnv()).toThrow('Latch');vi.stubEnv('LATCH_TOKEN','test-only-provider-token');vi.stubEnv('CRON_SECRET','roque-local-cron');expect(()=>serverEnv()).toThrow('cron credentials');});
it('accepts distinct keys and complete required production configuration',()=>expect(serverEnv().latchRequired).toBe(true));
