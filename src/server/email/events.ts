import 'server-only';
import type {Db,Tx} from '../db';
import {env} from '../env';
import {enqueueEmail} from './outbox';
import {transactionalEmail} from './templates';
import {formatBRL} from '@/lib/money';
export async function enqueueOrderEmailsTx(tx:Db|Tx,orderId:string) {
 const order=await tx.order.findUnique({where:{id:orderId},select:{status:true,buyerEmail:true}});
 if(!order||order.status!=='PAID')return;
 for(const template of ['PURCHASE_CONFIRMATION','TICKET_DELIVERY'])await enqueueEmail(tx,{dedupeKey:template+':'+orderId,template,recipient:order.buyerEmail,payload:{orderId}});
}
export async function enqueueRefundEmailTx(tx:Tx,refundId:string) {
 const refund=await tx.refund.findUniqueOrThrow({where:{id:refundId},include:{order:{include:{event:true}}}});
 if(refund.status!=='SUCCEEDED')return;
 const o=refund.order;
 await enqueueEmail(tx,{dedupeKey:'refund:'+refund.id,template:'REFUND_CONFIRMATION',recipient:o.buyerEmail,message:transactionalEmail('refund',o.event.title,['Status do reembolso: confirmado pelo sistema financeiro.', 'Pedido '+o.publicCode,'Valor: '+formatBRL(refund.amountCents),'O prazo para aparecer na sua conta depende do meio de pagamento e da instituição.'],env().APP_URL+'/pedido/'+o.id)});
}
export async function enqueueCancelledEventEmailsTx(tx:Tx,eventId:string) {
 const event=await tx.event.findUniqueOrThrow({where:{id:eventId}});
 const orders=await tx.order.findMany({where:{eventId,status:'PAID'},select:{buyerEmail:true,tickets:{select:{holder:{select:{email:true}}}}}});
 const recipients=[...new Set(orders.flatMap(o=>[o.buyerEmail,...o.tickets.map(t=>t.holder.email)]))];
 for(const recipient of recipients)await enqueueEmail(tx,{dedupeKey:'cancel:'+eventId+':'+recipient.toLowerCase(),template:'EVENT_CANCELLED',recipient,message:transactionalEmail('cancelled',event.title,['O evento foi cancelado.','Motivo: '+(event.cancellationReason??'Consulte os detalhes do evento.'),'Acompanhe o estado real do reembolso em sua conta. O cancelamento não significa que o estorno já foi concluído.'],env().APP_URL+'/meus-pedidos')});
}
