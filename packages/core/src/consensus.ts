import {TransactionStatus,transactionsStatusNameToNumber,type GenLayerTransaction} from 'genlayer-js/types';
export class ConsensusExecutionError extends Error {}
/** SDK receipts may retain the numeric lifecycle code; finality and execution are separate. */
export function assertFinalizedConsensus(receipt:GenLayerTransaction):void{
 const status=String(receipt.status);
 if(status!==TransactionStatus.FINALIZED&&status!==transactionsStatusNameToNumber[TransactionStatus.FINALIZED])throw new Error('Consensus is not final.');
 if(receipt.txExecutionResult===2||receipt.txExecutionResultName==='FINISHED_WITH_ERROR'||receipt.consensus_data?.leader_receipt?.some(r=>r.error||r.execution_result==='ERROR'))throw new ConsensusExecutionError('Finalized consensus execution failed.');
}
