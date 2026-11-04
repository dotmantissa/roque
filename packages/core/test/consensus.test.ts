import {it,expect} from 'vitest';
import {assertFinalizedConsensus} from '../src/consensus.js';
it('accepts finalized numeric SDK receipts and rejects accepted receipts',()=>{expect(()=>assertFinalizedConsensus({status:7})).not.toThrow();expect(()=>assertFinalizedConsensus({status:6})).toThrow('not final');});
it('rejects execution failure even when finality is reached',()=>{expect(()=>assertFinalizedConsensus({status:7,consensus_data:{final:true,leader_receipt:[{execution_result:'ERROR'} as never]}})).toThrow('execution failed');expect(()=>assertFinalizedConsensus({status:7,txExecutionResult:2})).toThrow('execution failed');});
