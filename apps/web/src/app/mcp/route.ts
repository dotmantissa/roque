import {dispatchPublic} from "../_public-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export const GET=(req:Request)=>dispatchPublic(req);
export const POST=(req:Request)=>dispatchPublic(req);
export const DELETE=(req:Request)=>dispatchPublic(req);
export const OPTIONS=(req:Request)=>dispatchPublic(req);
