import 'server-only';
import {randomUUID} from 'node:crypto';
import type {Db,Tx} from '../db';
import {encryptPII,decryptPII,hashToken} from '../crypto';
import {AppError} from '../errors';
import {getEmailAdapter,EmailDeliveryError,type EmailAdapter,type EmailMessage} from './index';
export async function consumeEmailRateLimit(db:Db,key:string,limit:number,windowMs:number) {
 await db.$transaction(async tx=>{
  const hashed=hashToken(key);await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',hashed);
  const now=new Date();const current=await tx.emailRateLimit.findUnique({where:{key:hashed}});
  const fresh=!current||now.getTime()-current.windowStartedAt.getTime()>=windowMs;
  if(!fresh&&current.count>=limit)throw new AppError('RATE_LIMITED','Aguarde antes de solicitar outro e-mail.');
  await tx.emailRateLimit.upsert({where:{key:hashed},create:{key:hashed,count:1,windowStartedAt:now},update:fresh?{count:1,windowStartedAt:now}:{count:{increment:1}}});
 });
}
function encodeMessage(msg:EmailMessage) {return encryptPII(JSON.stringify({...msg,attachments:msg.attachments?.map(a=>({...a,content:Buffer.from(a.content).toString('base64')}))}));}
function decodeMessage(value:string):EmailMessage {const msg=JSON.parse(decryptPII(value));return {...msg,attachments:msg.attachments?.map((a:{filename:string;content:string;contentType:string})=>({...a,content:Buffer.from(a.content,'base64')}))};}
export async function enqueueEmail(client:Db|Tx,input:{dedupeKey:string;template:string;recipient:string;message?:Omit<EmailMessage,'to'>;payload?:Record<string,unknown>;expiresAt?:Date}) {
 return client.emailOutbox.upsert({where:{dedupeKey:input.dedupeKey},create:{dedupeKey:input.dedupeKey,template:input.template,recipient:input.recipient.toLowerCase(),messageEncrypted:input.message?encodeMessage({...input.message,to:input.recipient}):undefined,payloadEncrypted:input.payload?encryptPII(JSON.stringify(input.payload)):undefined,expiresAt:input.expiresAt},update:{}});
}
export async function dispatchEmailOutbox(db:Db,opts:{limit?:number;ids?:string[];adapter?:EmailAdapter}={}) {
 const adapter=opts.adapter??getEmailAdapter();let sent=0,failed=0;
 for(let i=0;i<Math.min(opts.limit??20,100);i++) {
  const now=new Date();
  const job=await db.$transaction(async tx=>{
   const where={...(opts.ids?{id:{in:opts.ids}}:{}),OR:[{status:'QUEUED' as const,nextAttemptAt:{lte:now}},{status:'PROCESSING' as const,lockedUntil:{lt:now}}]};
   const candidate=await tx.emailOutbox.findFirst({where,orderBy:{createdAt:'asc'}});if(!candidate)return null;
   await tx.$queryRawUnsafe('SELECT id FROM "EmailOutbox" WHERE id=$1 FOR UPDATE',candidate.id);
   const current=await tx.emailOutbox.findFirst({where:{...where,id:candidate.id}});if(!current)return null;
   if(current.expiresAt&&current.expiresAt<=now){await tx.emailOutbox.update({where:{id:current.id},data:{status:'CANCELLED',messageEncrypted:null,payloadEncrypted:null,errorCode:'EXPIRED',leaseToken:null,lockedUntil:null}});return null;}
   // Provider idempotency is limited to24h. Never blindly retry ambiguous older deliveries.
   if(current.firstAttemptAt&&now.getTime()-current.firstAttemptAt.getTime()>23*3_600_000){await tx.emailOutbox.update({where:{id:current.id},data:{status:'UNKNOWN',errorCode:'IDEMPOTENCY_WINDOW_EXPIRED',leaseToken:null,lockedUntil:null}});return null;}
   return tx.emailOutbox.update({where:{id:current.id},data:{status:'PROCESSING',provider:adapter.id,attemptCount:{increment:1},firstAttemptAt:current.firstAttemptAt??now,lockedUntil:new Date(now.getTime()+120_000),leaseToken:randomUUID()}});
  });
  if(!job)break;
  try {
   let encoded=job.messageEncrypted;
   if(!encoded){const payload=JSON.parse(decryptPII(job.payloadEncrypted!));const {buildQueuedOrderEmail}=await import('../services/notifications');const message=await buildQueuedOrderEmail(db,job.template,payload.orderId);if(!message){await db.emailOutbox.updateMany({where:{id:job.id,leaseToken:job.leaseToken},data:{status:'CANCELLED',payloadEncrypted:null,errorCode:'RESOURCE_NO_LONGER_ELIGIBLE',lockedUntil:null,leaseToken:null}});continue;}encoded=encodeMessage(message);await db.emailOutbox.updateMany({where:{id:job.id,leaseToken:job.leaseToken},data:{messageEncrypted:encoded}});}
   const receipt=await adapter.send(decodeMessage(encoded),{idempotencyKey:'email/'+job.id});
   const updated=await db.emailOutbox.updateMany({where:{id:job.id,status:'PROCESSING',leaseToken:job.leaseToken},data:{status:'SENT',providerMessageId:receipt?.id??null,sentAt:new Date(),errorCode:null,messageEncrypted:null,payloadEncrypted:null,lockedUntil:null,leaseToken:null}});sent+=updated.count;
  }catch(error){const safe=error instanceof EmailDeliveryError?error:new EmailDeliveryError('DELIVERY_FAILED',true);const retry=safe.retryable&&job.attemptCount<5;
   await db.emailOutbox.updateMany({where:{id:job.id,status:'PROCESSING',leaseToken:job.leaseToken},data:{status:retry?'QUEUED':'FAILED',failedAt:new Date(),errorCode:safe.code,nextAttemptAt:new Date(Date.now()+Math.min(60_000*2**job.attemptCount,3_600_000)),lockedUntil:null,leaseToken:null}});failed++;
  }
 }
 // Minimize retained encrypted content for terminal/abandoned deliveries after7days.
 await db.emailOutbox.updateMany({where:{createdAt:{lt:new Date(Date.now()-7*86_400_000)},status:{in:['SENT','FAILED','CANCELLED','UNKNOWN']}},data:{messageEncrypted:null,payloadEncrypted:null}});
 await db.emailRateLimit.deleteMany({where:{windowStartedAt:{lt:new Date(Date.now()-2*86_400_000)}}});
 return {sent,failed};
}
