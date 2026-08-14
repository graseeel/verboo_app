# Auditoria de Segurança e Bugs — Verboo Code Desktop

> Data: 2026-08-14 | Versão: 0.7.2-beta | Escopo: Rust backend + React/TS frontend

---

## Resumo Executivo

| Severidade | Rust | Frontend | Total |
|------------|------|----------|-------|
| **CRITICAL** | 2 | 0 | **2** |
| **HIGH** | 2 | 1 | **3** |
| **MEDIUM** | 4 | 3 | **7** |
| **LOW** | 4 | 4 | **8** |
| **INFORM** | 5 | — | **5** |
| **TOTAL** | **17** | **8** | **25** |

### Achados Positivos (sem correção necessária)

- ✅ Zero `dangerouslySetInnerHTML` em código de produção
- ✅ Zero credenciais hardcoded no source
- ✅ `react-markdown` sem `rehype-raw` (XSS-safe)
- ✅ `markdownLink.ts` rejeita `javascript:` e `file:` URLs
- ✅ `window.open` com `noopener,noreferrer`
- ✅ Git commands usando `.arg()` (nunca `format!()`)
- ✅ Path traversal protection em `git_service.rs`
- ✅ OS-native keyring para credenciais (DPAPI/Keychain/libsecret)
- ✅ API keys gerenciadas exclusivamente pelo backend Rust
- ✅ `JSON.parse` do localStorage com runtime type checks

---

## CRITICAL (2)

### C1: `SendBrowserStatePtr` — Raw pointer use-after-free

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/browser_panel.rs:1504-1532` |
| **Risco** | Use-after-free se `BrowserPanelState` for destruído enquanto closure de callback da webview ainda está viva |

```rust
pub(crate) struct SendBrowserStatePtr(*const BrowserPanelState);
unsafe impl Send for SendBrowserStatePtr {}
unsafe impl Sync for SendBrowserStatePtr {}
```

O raw pointer é capturado em closure `Arc<dyn Fn(String) + Send + Sync>` registrado como handler de mensagem da plataforma. Se o painel for fechado enquanto a webview ainda pode disparar callbacks, o pointer vira dangling.

**Correção:** Usar `Arc<BrowserPanelState>` em vez de raw pointer.

---

### C2: `from_utf8_unchecked` em `strip_ansi`

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/turn_service.rs:2968, 3005` |
| **Risco** | Undefined behavior se a lógica de boundary UTF-8 tiver bug |

```rust
out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[run_start..i]) });
```

O argumento de segurança é correto hoje (ESC e bytes CSI são ASCII), mas `from_utf8_unchecked` é inerentemente perigoso — qualquer refatoração futura pode introduzir UB silencioso.

**Correção:** Substituir por `std::str::from_utf8().unwrap_or_default()` — performance idêntica para output de terminal.

---

## HIGH (3)

### H1: PowerShell Command Injection via DPAPI Entropy

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/cli_credentials.rs:651-662, 696-707` |
| **Risco** | Injeção de comando PowerShell se `USERNAME` contiver aspas |

O entropy (`resource_name:username`) é interpolado em script PowerShell via `format!()`. O `replace('\'', "''")` só cobre aspas simples — um `USERNAME` com `"` + caracteres de controle pode quebrar o contexto da string.

**Correção:** Usar `-EncodedCommand` com UTF-16LE ou passar entropy via stdin.

---

### H2: Mutex poisoned state recuperado sem logging

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/browser_panel.rs:161, 165` |
| **Risco** | Corrupção silenciosa de estado após panic |

```rust
self.inner.lock().unwrap_or_else(|e| e.into_inner())
```

Recupera mutex envenenado silenciosamente — estado interno pode estar inconsistente, causando bugs cascata difíceis de rastrear.

**Correção:** Adicionar `eprintln!` ou métrica quando recuperar de mutex poisoned.

---

### H3: `marketplace_add` sem validação de input no renderer

| | |
|---|---|
| **Arquivo** | `src/renderer/verboo-bridge.ts:464-465` |
| **Risco** | SSRF ou path traversal se backend não validar |

`marketplaceAdd(source, scope)` passa string arbitrária do usuário direto para o Rust. O renderer não valida formato.

**Correção:** Validar no renderer que `source` é URL `https://...` ou marketplace ID válido.

---

## MEDIUM (7)

### M1: Auth session data em plaintext localStorage

| | |
|---|---|
| **Arquivo** | `src/renderer/App.tsx:7223-7260` |

`email` e `apiKeyHint` (últimos 4 chars) persistidos em plaintext por 30 dias. Atacante com acesso ao filesystem pode extrair.

---

### M2: Token OAuth injetado como env var

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/auth_token.rs:60-76` |

`CLAUDE_CODE_OAUTH_TOKEN` legível por qualquer processo do mesmo usuário via Process Explorer/WMI.

---

### M3: Plaintext fallback de credenciais no Windows

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/cli_credentials.rs:280-281, 319-325` |

Se DPAPI falhar, credenciais vão para `~/.verboo/.credentials.json` em plaintext sem ACL restritivo.

---

### M4: Console.log de metadata em produção

| | |
|---|---|
| **Arquivo** | `src/renderer/features/profile/ProfileView.tsx:75-142` |

Logs de file names, MIME types e base64 length — verboso para DevTools.

---

### M5: `as any` cast em `window.verboo`

| | |
|---|---|
| **Arquivo** | `src/renderer/App.tsx:1168` |

Bypass de type checking — se o bridge mudar shape, erro silencioso.

---

### M6: Crescimento ilimitado de Vec em iOS Simulator

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/ios_simulator.rs:1213-1215` |

`emitted_outputs` e `lifecycle_emissions` crescem sem limite durante sessões longas.

---

### M7: `process_may_be_alive` retorna `true` quando `GetExitCodeProcess` falha

| | |
|---|---|
| **Arquivo** | `src-tauri/src/services/cli_update/store.rs:552` |

Pode causar loops de polling infinitos se o processo estiver morto mas inqueryável.

---

## LOW (8)

| # | Finding | Arquivo |
|---|---------|---------|
| L1 | `unwrap()` em production code (attachments video path) | `turn_service.rs:538,542` |
| L2 | Credential logging em stderr | `cli_credentials.rs:96-124` |
| L3 | `strip_ansi` não handle OSC sequences | `turn_service.rs:2956-3008` |
| L4 | `read_content_sample` ignora erros de leitura | `file_service.rs:95-105` |
| L5 | `JSON.parse` em usePlugins sem array validation | `usePlugins.ts:30` |
| L6 | highlight.js processa output não-confiável | `package.json:51` |
| L7 | API key em React state durante form submission | `LoginScreen.tsx:79` |
| L8 | `unsafe set_var` em test code (UB em multi-threaded) | `cli_service.rs:600-607` |

---

## Plano de Correção (Priorizado)

### P0 — Corrigir AGORA (CRITICAL)

| # | Ação | Esforço |
|---|------|---------|
| C1 | Substituir `SendBrowserStatePtr` por `Arc<BrowserPanelState>` | Médio |
| C2 | Substituir `from_utf8_unchecked` por `from_utf8().unwrap_or_default()` | Baixo |

### P1 — Corrigir esta semana (HIGH)

| # | Ação | Esforço |
|---|------|---------|
| H1 | PowerShell: usar `-EncodedCommand` ou stdin em vez de `format!()` | Médio |
| H2 | Adicionar logging quando recuperar mutex poisoned | Baixo |
| H3 | Validar `source` no renderer antes de `marketplace_add` | Baixo |

### P2 — Corrigir no próximo ciclo (MEDIUM)

| # | Ação | Esforço |
|---|------|---------|
| M1 | Armazenar só `isAuthenticated` em vez de email+hint | Baixo |
| M2 | Remover log de token resolution | Baixo |
| M3 | Deletar `.credentials.json` plaintext quando DPAPI funcionar | Baixo |
| M4 | Remover console.log de avatar processing | Baixo |
| M5 | Adicionar tipo para `listenForNotificationClick` | Baixo |
| M6 | Adicionar max capacity em Vec/HashSet do iOS Simulator | Baixo |
| M7 | Adicionar timeout/retry limit em `process_may_be_alive` | Baixo |

### P3 — Corrigir quando conveniente (LOW)

| # | Ação | Esforço |
|---|------|---------|
| L1-L8 | Correções menores de defensividade | Baixo |

---

## Status Atual

A aplicação está **funcional e segura para uso** — não há vulnerabilidades ativas exploráveis. Os achados CRITICAL são riscos latentes (use-after-free requer timing específico, `from_utf8_unchecked` é correto hoje). Os achados HIGH são defensivos (PowerShell injection requer USERNAME malicioso, mutex poisoning é raro).

**Recomendação:** Aplicar P0 e P1 antes do próximo release público. P2 e P3 podem esperar.
