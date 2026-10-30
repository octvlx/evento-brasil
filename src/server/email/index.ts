import 'server-only';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Resend } from 'resend';
import {env} from '../env';
export interface EmailMessage {to:string;subject:string;html:string;text:string;attachments?:{filename:string;content:Uint8Array;contentType:string}[]}
export interface EmailAdapter {readonly id:string;send(msg:EmailMessage,options?:{idempotencyKey?:string}):Promise<void|{id:string}>}
export class EmailDeliveryError extends Error {constructor(public readonly code:string,public readonly retryable:boolean){super('Não foi possível entregar o e-mail ('+code+').');}}
export class ConsoleEmailAdapter implements EmailAdapter {
 readonly id='console';
 async send(msg:EmailMessage,options?:{idempotencyKey?:string}) {
  if(env().NODE_ENV==='production')throw new EmailDeliveryError('CONSOLE_FORBIDDEN',false);
  const dir=path.resolve('.data/outbox');await mkdir(dir,{recursive:true});
  const key=(options?.idempotencyKey??randomUUID()).replace(/[^a-zA-Z0-9_-]/g,'_');
  await writeFile(path.join(dir,key+'.html'),msg.html);
  await writeFile(path.join(dir,key+'.txt'),msg.text);
  for(const a of msg.attachments??[])await writeFile(path.join(dir,key+'-'+path.basename(a.filename)),a.content);
  console.info('[email:console] mensagem local '+key+' → '+path.join(dir,key+'.html'));
  return {id:'console:'+key};
 }
}
export class ResendEmailAdapter implements EmailAdapter {
 readonly id='resend';private readonly sdk:Resend;
 constructor(key:string,private readonly from:string,private readonly replyTo?:string){this.sdk=new Resend(key);}
 async send(msg:EmailMessage,options?:{idempotencyKey?:string}) {
  try {
   const {data,error}=await this.sdk.emails.send({from:this.from,to:[msg.to],replyTo:this.replyTo||undefined,subject:msg.subject,html:msg.html,text:msg.text,attachments:msg.attachments?.map(a=>({filename:a.filename,content:Buffer.from(a.content),contentType:a.contentType}))},{idempotencyKey:options?.idempotencyKey});
   if(error){const status=error.statusCode??500;throw new EmailDeliveryError(status===403?'RECIPIENT_OR_DOMAIN_UNAUTHORIZED':status===409?'IDEMPOTENCY_CONFLICT':status===429?'RATE_LIMITED':status>=500?'PROVIDER_UNAVAILABLE':'PROVIDER_REJECTED',status===429||status>=500);}
   if(!data?.id)throw new EmailDeliveryError('PROVIDER_UNAVAILABLE',true);
   return {id:data.id};
  }catch(e){if(e instanceof EmailDeliveryError)throw e;throw new EmailDeliveryError('PROVIDER_UNAVAILABLE',true);}
 }
}
let adapter:EmailAdapter|undefined;
export function getEmailAdapter():EmailAdapter {if(adapter)return adapter;const e=env();adapter=e.EMAIL_PROVIDER==='resend'?new ResendEmailAdapter(e.RESEND_API_KEY||e.EMAIL_API_KEY!,e.EMAIL_FROM,e.EMAIL_REPLY_TO):new ConsoleEmailAdapter();return adapter;}
export const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
