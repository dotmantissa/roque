import {serverEnv} from "@roque/core/env";
import {interpretationTick,walletSettlementTick} from "@roque/core/public-api";
import {reconcileRelayerAttempts} from "@roque/core/sender";
import {maintenanceTick} from "@roque/core/admission";
import {run} from "../../_util";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(req:Request){
 if(req.headers.get("authorization")!==`Bearer ${serverEnv().cronSecret}`)return new Response(null,{status:401});
 return run(async()=>{await reconcileRelayerAttempts();await walletSettlementTick();await maintenanceTick();await interpretationTick();return {ok:true};});
}
export const POST=GET;
