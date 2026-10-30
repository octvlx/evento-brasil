import { escapeHtml } from './index';
export function emailLayout(title: string, body: string, button?: {label:string;url:string}) {
 const safe=escapeHtml;
 return '<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f3ff;font-family:Arial,sans-serif;color:#14112b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;background:white;border-radius:16px" cellspacing="0" cellpadding="0"><tr><td style="padding:24px;background:#312e81;color:white;font-size:22px;font-weight:bold">Evento Brasil</td></tr><tr><td style="padding:28px"><h1 style="font-size:24px;color:#312e81">'+safe(title)+'</h1>'+body+(button?'<p style="margin:28px 0"><a style="display:inline-block;background:#6d28d9;color:white;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:bold" href="'+safe(button.url)+'">'+safe(button.label)+'</a></p><p style="font-size:12px;word-break:break-all">Se o botão não abrir, copie o endereço: '+safe(button.url)+'</p>':'')+'</td></tr><tr><td style="padding:24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">Mensagem automática do Evento Brasil. Proteja sua conta e não compartilhe links de acesso ou ingressos.</td></tr></table></td></tr></table></body></html>';
}
export function authEmail(kind:'reset'|'verify',url:string,minutes:number) {
 const reset=kind==='reset';const title=reset?'Redefinição de senha':'Bem-vindo ao Evento Brasil!';
 const subject=reset?'Redefinição de senha | Evento Brasil':'Confirme seu e-mail | Evento Brasil';
 const intro=reset?'Recebemos um pedido de redefinição da sua senha.':'Estamos felizes por você fazer parte da nossa comunidade. Confirme seu endereço de e-mail para concluir compras e usar operações que exigem verificação.';
 const label=reset?'Redefinir senha':'Confirmar meu e-mail';
 return {subject,html:emailLayout(title,'<p>'+intro+'</p><p>O link expira em '+minutes+' minutos e só pode ser utilizado uma vez.</p><p>Se você não solicitou esta mensagem, ignore-a.</p>',{label,url}),text:title+'\n'+intro+'\n'+label+': '+url+'\nValidade: '+minutes+' minutos. Se você não solicitou, ignore esta mensagem.'};
}
export function transactionalEmail(kind:'purchase'|'tickets'|'cancelled'|'refund'|'invitation'|'event',title:string,lines:string[],url:string) {
 const subjects={purchase:'Compra confirmada! | Evento Brasil',tickets:'Seus ingressos chegaram! | Evento Brasil',cancelled:'Atualização importante sobre seu evento | Evento Brasil',refund:'Atualização do seu reembolso | Evento Brasil',invitation:'Você recebeu um convite | Evento Brasil',event:'Atualização importante sobre seu evento | Evento Brasil'};
 const label=kind==='invitation'?'Visualizar convite':kind==='tickets'?'Visualizar meus ingressos':'Ver detalhes';
 return {subject:subjects[kind],html:emailLayout(title,lines.map(line=>'<p>'+escapeHtml(line)+'</p>').join(''),{label,url}),text:[title,...lines,label+': '+url].join('\n')};
}
