import {TransactionStatus,transactionsStatusNameToNumber,type GenLayerTransaction} from 'genlayer-js/types';
export class ConsensusExecutionError extends Error {}
/** Finality records an outcome; require affirmative execution success before using it. */
export function assertFinalizedConsensus(receipt:GenLayerTransaction):void{
 const status=String(receipt.status);
 if(status!==TransactionStatus.FINALIZED&&status!==transactionsStatusNameToNumber[TransactionStatus.FINALIZED])throw new Error('Consensus is not final.');
 // Earlier leader attempts can fail before a successful rotation. The final
 // leader and the chain's canonical execution result describe the outcome.
 const leader=receipt.consensus_data?.leader_receipt?.at(-1);
 if(receipt.txExecutionResult===2||receipt.txExecutionResultName==='FINISHED_WITH_ERROR'||leader?.error||leader?.execution_result==='ERROR')throw new ConsensusExecutionError('Finalized consensus execution failed.');
 const canonicalSuccess=receipt.txExecutionResult===1||receipt.txExecutionResultName==='FINISHED_WITH_RETURN';
 if((leader&&leader.execution_result!=='SUCCESS')||(!leader&&!canonicalSuccess))throw new Error('Consensus execution success is not available.');
}
