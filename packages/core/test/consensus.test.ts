import {it,expect} from 'vitest';
import {assertFinalizedConsensus} from '../src/consensus.js';
const leaders=(...outcomes:string[])=>({leader_receipt:outcomes.map(execution_result=>({execution_result}))}) as never;
it('accepts numeric and named finalized receipts with affirmative execution success',()=>{
 expect(()=>assertFinalizedConsensus({status:7,consensus_data:leaders('SUCCESS')})).not.toThrow();
 expect(()=>assertFinalizedConsensus({status:'FINALIZED',txExecutionResult:1})).not.toThrow();
 expect(()=>assertFinalizedConsensus({status:6,txExecutionResult:1})).toThrow('not final');
});
it('rejects execution failure even when finality is reached',()=>{
 expect(()=>assertFinalizedConsensus({status:7,consensus_data:leaders('ERROR')})).toThrow('execution failed');
 expect(()=>assertFinalizedConsensus({status:7,txExecutionResult:2})).toThrow('execution failed');
 expect(()=>assertFinalizedConsensus({status:7,txExecutionResult:1,consensus_data:leaders('ERROR')})).toThrow('execution failed');
});
it('does not infer execution success from missing or unrecognized outcomes',()=>{
 for(const receipt of [{status:7},{status:7,txExecutionResult:0},{status:7,consensus_data:leaders('UNKNOWN')}])expect(()=>assertFinalizedConsensus(receipt)).toThrow('success is not available');
});
it('checks the final leader outcome after a rotation',()=>{
 expect(()=>assertFinalizedConsensus({status:7,consensus_data:leaders('ERROR','SUCCESS')})).not.toThrow();
 expect(()=>assertFinalizedConsensus({status:7,consensus_data:leaders('SUCCESS','ERROR')})).toThrow('execution failed');
});
