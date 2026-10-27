# Pontos para revisão jurídica e contábil (Brasil)

Este software **não** afirma conformidade legal. Os itens abaixo foram
implementados de forma configurável ou documentados como pendentes e precisam
de parecer de advogado(a) e contador(a) antes do lançamento comercial.

> **Decreto nº 13.108/2026 (venda de ingressos):** análise de lacunas e plano
> por agente em [`conformidade-decreto-13108.md`](conformidade-decreto-13108.md).

## Direito do consumidor

- **Direito de arrependimento (CDC art. 49)** e sua aplicação a ingressos de
  eventos com data marcada. Hoje: janela configurável `REFUND_WINDOW_DAYS=7`
  após a compra **e** `REFUND_MIN_HOURS_BEFORE_EVENT=48` antes do evento.
- **Cancelamento/adiamento pelo organizador:** política atual = reembolso
  integral automático (incluindo taxa de serviço) e revogação dos ingressos.
  Avaliar regras específicas para adiamento/remarcação.
- **Responsabilidade solidária do marketplace** pela realização do evento e
  pelas informações publicadas.
- **Transparência de preços e taxas:** taxa de serviço exibida antes do
  pagamento; validar redação, momento de exibição e vedação de taxas ocultas.
- **Venda casada, conveniência e taxa de retirada:** confirmar legalidade da
  taxa de serviço conforme o modelo escolhido (`bearer` ORGANIZER/BUYER).
- **Chargeback:** política padrão atual = perda do organizador (comissão retida).

## Meia-entrada (Lei 12.933/2013 e Decreto 8.537/2015)

- Público beneficiário, documentos aceitos e verificação na entrada.
- **Cota** (o sistema permite configurar % da capacidade por evento;
  o seed usa 40% apenas como exemplo) e regras para eventos com venda
  antecipada/lotes.
- Obrigação de informar a quantidade disponível e relatórios de cota
  (há relatório por evento em *Vendas e repasses*).
- Outras gratuidades/descontos estaduais e municipais (idosos, professores,
  doadores de sangue etc.).

## LGPD

- Bases legais por finalidade; política de privacidade definitiva; encarregado (DPO).
- Retenção: prazos para pedidos, logs de check-in, auditoria e dados de
  organizadores (CPF/CNPJ é cifrado com AES-256-GCM; chave em `DATA_ENCRYPTION_KEY`).
- Compartilhamento com organizadores (lista de participantes/CSV — exportações
  são registradas na auditoria) e com operadores (provedor de pagamento, e-mail,
  armazenamento, hospedagem) — contratos e transferência internacional.
- Atendimento aos direitos do titular (acesso, correção, portabilidade, exclusão).
- Cookies: apenas essenciais nesta versão (sessão, cidade preferida).

## Fiscal e contábil

- **Documentos fiscais:** NFS-e da comissão/taxa de serviço da plataforma
  (município da sede, alíquota de ISS) e obrigações do organizador sobre a venda
  dos ingressos.
- Tratamento da receita: plataforma como intermediária (receita = comissão) vs.
  revenda; impacto em PIS/COFINS/IRPJ/CSLL e no regime tributário.
- Retenções na fonte e informes de rendimentos para organizadores pessoa física.
- O razão interno (`FinancialLedgerEntry`) é ferramenta de **conciliação**, não
  escrituração contábil oficial.

## Pagamentos e regulação

- Arranjos de pagamento/BACEN: a plataforma **não** deve custodiar recursos;
  o modelo previsto é split nativo do provedor licenciado. Validar com o
  provedor e assessoria regulatória.
- Contratos: termos com organizadores (repasse, prazos, comissão, estornos),
  termos de uso do comprador.

## Outros

- Classificação etária e ECA (entrada de menores).
- Acessibilidade (Lei Brasileira de Inclusão — Lei 13.146/2015) nas informações
  do evento e na própria plataforma.
- Retenção e uso de dados de check-in.
