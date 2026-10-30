import {beforeEach,expect,it,vi} from 'vitest';
import {adapter,orderInput,buyAndPay,db,makeUser,makeOrg,makeEvent,makeCategory,resetDb} from '../support/fixtures';
import {requestCustomerRefund} from '@/server/services/refunds';
import {handlePaymentWebhook} from '@/server/services/payments';
import {submitOrganizerApplication,resubmitOrganizerApplication} from '@/server/services/organizers';
import {organizerDashboard,dailySales} from '@/server/services/reports';
import {startEventDraft,saveEventWizardStep,recordWizardVisit} from '@/server/services/event-wizard';
import {getWizardProgress} from '@/server/services/event-wizard-progress';
import {createCoupon,updateCoupon} from '@/server/services/coupons';
import {createOrder} from '@/server/services/orders';
beforeEach(resetDb);
const application=(name:string)=>({name,legalType:'COMPANY' as const,legalName:name+' LTDA',document:'11.222.333/0001-81',contactEmail:'test@example.com'});
it.each(['throw','refuse'] as const)('preserves webhook-confirmed success after late %s',async outcome=>{
 const event=await makeEvent(await makeOrg(await makeUser()));const buyer=await makeUser();
 const {order}=await buyAndPay(buyer,event.id,[{ticketTypeId:event.ticketTypes[0].id,quantity:1}]);
 const real=adapter.refundPayment.bind(adapter);
 const spy=vi.spyOn(adapter,'refundPayment').mockImplementationOnce(async input=>{const result=await real(input);expect((await handlePaymentWebhook(db,adapter,adapter.buildWebhook(input.providerPaymentId))).status).toBe(200);if(outcome==='throw')throw Error('lost response');return {...result,status:'FAILED'};});
 try{const refund=await requestCustomerRefund(db,adapter,buyer,order.id);expect(refund.status).toBe('SUCCEEDED');expect(await db.auditLog.count({where:{entityId:refund.id,action:'refund.attempt_failed'}})).toBe(0);expect((await db.ticketType.findUniqueOrThrow({where:{id:event.ticketTypes[0].id}})).quantityRefunded).toBe(1);}finally{spy.mockRestore();}
});
it('serializes pending submissions and prevents resubmission above the owner limit',async()=>{
 const owner=await makeUser();for(let i=0;i<2;i++)await submitOrganizerApplication(db,owner,application('Initial '+i));
 const results=await Promise.allSettled([submitOrganizerApplication(db,owner,application('Concurrent A')),submitOrganizerApplication(db,owner,application('Concurrent B'))]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(await db.organizationMember.count({where:{userId:owner.id,organization:{status:'PENDING_REVIEW'}}})).toBe(3);
 const rejected=await makeOrg(owner);await db.organization.update({where:{id:rejected.id},data:{status:'REJECTED'}});
 await expect(resubmitOrganizerApplication(db,owner,rejected.id,application('Resubmit'))).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
});
it('supports dashboard and daily revenue over Int32',async()=>{
 const owner=await makeUser();const org=await makeOrg(owner);const event=await makeEvent(org,{capacity:1000,tickets:[{priceCents:10_000_000,quantityTotal:1000,maxPerOrder:50}]});
 for(let i=0;i<5;i++)await buyAndPay(await makeUser(),event.id,[{ticketTypeId:event.ticketTypes[0].id,quantity:50}]);
 expect((await organizerDashboard(db,owner,org.id)).eventPerformance?.[0].grossCents).toBe(2_500_000_000);
 expect((await dailySales(db,owner,org.id)).reduce((sum,r)=>sum+r.totalCents,0)).toBe(2_500_000_000);
});
it('keeps completed wizard steps through overlapping visits and saves',async()=>{
 const owner=await makeUser();const org=await makeOrg(owner);const category=await makeCategory();const {event}=await startEventDraft(db,owner,org.id,{draftKey:'audit-wizard-123',title:'Audit event',categoryId:category.id});
 await Promise.all([recordWizardVisit(db,owner,event.id,2),saveEventWizardStep(db,owner,event.id,1,{title:'Audit event',categoryId:category.id},{complete:true}),recordWizardVisit(db,owner,event.id,3)]);
 expect((await getWizardProgress(db,event.id)).completed).toContain(1);
});
it('serializes coupon edits against first checkout and preserves immutable used discounts',async()=>{
 const owner=await makeUser();const event=await makeEvent(await makeOrg(owner));const buyer=await makeUser();
 const input={code:'ORIGINAL',discountType:'PERCENT' as const,percentBps:1000,amountCents:null,validFromLocal:'',validUntilLocal:'',maxUses:null,maxUsesPerUser:null,ticketTypeIds:[]};
 const {coupon}=await createCoupon(db,owner,event.id,input);
 const [purchase]=await Promise.allSettled([createOrder(db,buyer,orderInput(event.id,[{ticketTypeId:event.ticketTypes[0].id,quantity:1}],{couponCode:'ORIGINAL'}),{providerIsSimulated:true}),updateCoupon(db,owner,coupon.id,{...input,code:'CHANGED',percentBps:2000})]);
 const stored=await db.coupon.findUniqueOrThrow({where:{id:coupon.id}});
 if(purchase.status==='fulfilled'){expect(stored.code).toBe('ORIGINAL');expect(stored.percentBps).toBe(1000);}else{expect(stored.code).toBe('CHANGED');await createOrder(db,buyer,orderInput(event.id,[{ticketTypeId:event.ticketTypes[0].id,quantity:1}],{couponCode:'CHANGED'}),{providerIsSimulated:true});}
 await expect(updateCoupon(db,owner,coupon.id,{...input,code:'LATER'})).rejects.toMatchObject({code:'VALIDATION'});
});
