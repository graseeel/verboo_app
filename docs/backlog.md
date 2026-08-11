# Backlog

Entradas registradas durante o ciclo do branch `feat/provider-accounts-usage`.
Backlog ≠ compromisso — itens aqui NÃO estão agendados nem implementados.

## Sessão CLI por provedor (mudança de contrato) — registrado 2026-08-10

**Contexto (análise L4-A aprovada parcialmente):** quando UMA sessão de provedor
apodrece (ex: bloco de raciocínio vazio na sessão Claude), a opção aprovada e
implementada foi "Reiniciar sessão" (sessão limpa global — zero Rust). O item
abaixo é a evolução NÃO aprovada, que preserva a memória dos OUTROS provedores.

**Problema:** a sessão CLI é ÚNICA por conversa (`cliSessionId` global em
`StoredConversation`; `cliSessionProviderAccounts` guarda provider→accountId,
NÃO sessionId — `src/shared/types.ts:592`, `providerAccountBindings.ts:72-86`).
Limpar a sessão (L4-A) afeta todos os provedores; o modelo recomeça sem memória.

**Mudança de contrato necessária (não implementada):**
- Persistir `sessionId` POR PROVEDOR (novo campo, ex: `cliSessionProviderSessions[provider]`),
  gravado no resultado/erro do turno (`App.tsx` — hoje só o global é gravado).
- O turno do provedor X usa `--resume <sid-X> --fork-session --provider-account X`
  em vez do global — o CLI JÁ aceita resume+fork de sid arbitrário (sem mudança no CLI).
- O fork anterior de um provedor limpo não contém a corrupção do último provedor
  (a cauda ruim veio depois) — voltar ao fork limpo preservaria a memória dele.

**Aberto para decisão:** o que "sessão por provedor" significa com uma sessão
única por conversa (o histórico é compartilhado entre provedores via forks).

**Envolve:** `src/shared/types.ts` (contrato da conversa) + persistência +
lógica de resume no turno (renderer e/ou Rust — fence da Solda para o Rust).

## Risco residual: rotação de accessToken durante login pode disparar Connected — registrado 2026-08-10

**Contexto:** o login aditivo exige evidência OAuth (redirect_uri/localhost) antes de
emitir Connected (fix `53fef51`). A mitigação atual cobre a âncora do URL; a rotação
do accessToken (o CLI re-emite o token no fim do fluxo) ainda pode, em cenário de
timing, disparar Connected sem mudança de identidade.

**Mitigação futura (não implementada):** aceitar rotação-sem-mudança-de-identidade
SÓ após o awaiting ter sido emitido — se a rotação chegar antes do awaiting, tratar
como fluxo em andamento e não como Connected.

**Envolve:** `src-tauri/src/services/provider_login_pty.rs` (gate do Connected).
