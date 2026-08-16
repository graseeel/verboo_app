# Plano de Testes — MCP, Skills e Plugins (Verboo Code Desktop)

> Validação funcional dos 3 sistemas: MCP (tela/browser), Skills e Plugins.
> Data: 2026-08-14 | Versão: 0.7.2-beta

---

## 1. MCP — Browser (verboo-in-chrome)

### 1.1 Pré-requisitos

| Item | Verificação |
|------|-------------|
| Chrome instalado | `chrome.exe` acessível no PATH |
| Extensão Verboo | Extensão Chrome instalada e ativa |
| MCP registrado | `~/.verboo/.config.json` contém `verboo-in-chrome` em `mcpServers` |
| Sidecar existe | `src-tauri/binaries/verboo-in-chrome-x86_64-pc-windows-msvc.exe` |

### 1.2 Testes de Registro

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T1.2.1 | MCP listado no catálogo | Abrir Settings → MCP | `verboo-in-chrome` aparece como habilitado |
| T1.2.2 | Status do Chrome integration | Chat: "check chrome integration status" | Retorna status `configured` |
| T1.2.3 | Ping do sidecar | Executar `verboo-in-chrome.exe ping` | Exit code 0, output OK |

### 1.3 Testes de Navegação

| # | Teste | Prompt no Chat | Esperado |
|---|-------|---------------|----------|
| T1.3.1 | Abrir URL | "Navigate to https://example.com" | Tab carrega example.com |
| T1.3.2 | Ler página | "Read the page content" | Retorna texto visível + elementos interativos |
| T1.3.3 | Extrair dados estruturados | "Extract the page content as JSON" | JSON com título, links, texto |
| T1.3.4 | Clicar elemento | "Click the link 'More information'" | Navega para URL do link |
| T1.3.5 | Digitar em input | "Type 'hello world' in the search box" | Texto aparece no campo |

### 1.4 Testes de Screenshot (Tela)

| # | Teste | Prompt no Chat | Esperado |
|---|-------|---------------|----------|
| T1.4.1 | Screenshot do viewport | "Take a screenshot of the current page" | Imagem base64 retornada, visível no chat |
| T1.4.2 | Screenshot após navegação | Navegar para URL → "Take a screenshot" | Screenshot mostra a página carregada |
| T1.4.3 | Screenshot de página dinâmica | Abrir SPA → aguardar 3s → screenshot | Captura estado final, não loading |

### 1.5 Testes de Abas

| # | Teste | Prompt no Chat | Esperado |
|---|-------|---------------|----------|
| T1.5.1 | Listar abas | "List all open tabs" | Retorna lista de abas com títulos e URLs |
| T1.5.2 | Abrir nova aba | "Open a new tab with https://github.com" | Nova aba criada e focada |
| T1.5.3 | Trocar aba | "Switch to the first tab" | Foco muda para aba selecionada |
| T1.5.4 | Fechar aba | "Close the current tab" | Aba fechada, foco vai para aba adjacente |

### 1.6 Testes de Groups

| # | Teste | Prompt no Chat | Esperado |
|---|-------|---------------|----------|
| T1.6.1 | Criar grupo | "Create a tab group named 'Research'" | Grupo criado na barra de abas |
| T1.6.2 | Mover aba para grupo | "Move the current tab to 'Research'" | Aba move para o grupo |

---

## 2. MCP — iOS Simulator (verboo-ios-simulator)

> **Executar APENAS em macOS** — o MCP é `#[cfg(target_os = "macos")]` only.

### 2.1 Pré-requisitos

| Item | Verificação |
|------|-------------|
| macOS | Sistema operacional macOS |
| Xcode + Simulators | `xcrun simctl list devices` retorna devices |
| MCP registrado | `~/.verboo/.config.json` contém `verboo-ios-simulator` |

### 2.2 Testes

| # | Teste | Prompt no Chat | Esperado |
|---|-------|---------------|----------|
| T2.2.1 | Listar simuladores | "List iOS simulators" | Lista de devices com UDID, nome, estado |
| T2.2.2 | Anexar simulador | "Attach to iPhone 16 simulator" | Conecta ao device, retorna estado |
| T2.2.3 | Screenshot | "Take a screenshot of the simulator" | Imagem do frame atual |
| T2.2.4 | Digitar texto | "Type 'test' in the active text field" | Texto inserido no campo |
| T2.2.5 | Tap elemento | "Tap the Login button" | Toque registrado no botão |
| T2.2.6 | Listar apps | "List installed apps" | Lista de bundle IDs |
| T2.2.7 | Launch app | "Launch the app with bundle id com.example.app" | App abre no simulador |

---

## 3. Skills

### 3.1 Pré-requisitos

| Item | Verificação |
|------|-------------|
| Diretórios de skills | `~/.verboo/skills/` e/ou `<cwd>/.verboo/skills/` existem |
| SKILL.md válido | Pelo menos 1 skill com frontmatter YAML (`name:`, `description:`) |

### 3.2 Testes de Descoberta

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T3.2.1 | Listar skills do usuário | Criar `~/.verboo/skills/test-skill/SKILL.md` com `name: test-skill` | Skill aparece em `list_skills` |
| T3.2.2 | Listar skills do projeto | Criar `<cwd>/.verboo/skills/project-skill/SKILL.md` | Skill do projeto listado |
| T3.2.3 | De-duplicação | Criar skills com mesmo nome em user e project | Apenas uma entrada retornada (user prevalece) |
| T3.2.4 | Skills legados | Criar `~/.claude/skills/legacy/SKILL.md` | Skill listado com source=Legacy |

### 3.3 Testes de Aprovação

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T3.3.1 | Skill projeto precisa aprovação | Criar skill em `<cwd>/.verboo/skills/` | `pending_approval_skills` retorna a skill |
| T3.3.2 | Aprovar skill | Chamar `approve_skill` com path da skill | Skill pasa a ser confiável |
| T3.3.3 | Recusar skill | Fechar dialog de aprovação | Skill não é injetada no prompt |
| T3.3.4 | "Allow Once" | Clicar "Allow Once" no painel | Skill usada apenas nesta turn |
| T3.3.5 | "Always Trust" | Clicar "Always Trust" | Skill salva em `UserSettings.trusted_skills` |

### 3.4 Testes de Injeção no Prompt

| # | Teste | Prompt no Chat | Esperado |
|---|-------|---------------|----------|
| T3.4.1 | Skill ativada por nome | Criar skill `test-skill` → enviar mensagem | Skill description aparece no contexto do CLI |
| T3.4.2 | Múltiplas skills | Ativar 3 skills diferentes | Todas as 3 no contexto |
| T3.4.3 | Skill com conteúdo | SKILL.md com instruções detalhadas | Instruções visíveis para o modelo |

---

## 4. Plugins

### 4.1 Pré-requisitos

| Item | Verificação |
|------|-------------|
| CLI disponível | `verboo plugin list --json` retorna JSON válido |
| Auth configurada | API key ou OAuth token presente |
| Marketplace | Pelo menos 1 marketplace registrado |

### 4.2 Testes de Listagem

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T4.2.1 | Listar plugins instalados | Abrir Settings → Plugins | Lista de plugins instalados (pode ser vazia) |
| T4.2.2 | Listar plugins disponíveis | Clicar "Browse plugins" | Catálogo de plugins do marketplace |
| T4.2.3 | Detalhe do plugin | Clicar em um plugin | Detalhes: nome, descrição, skills, versão |

### 4.3 Testes de Instalação

| # | Teste | Prompt no Chat / UI | Esperado |
|---|-------|---------------------|----------|
| T4.3.1 | Instalar plugin | UI: clicar "Install" em plugin disponível | Plugin instalado, aparece na lista |
| T4.3.2 | Instalar plugin via CLI | `verboo plugin install <id> --scope user` | Mesmo resultado |
| T4.3.3 | Plugin já instalado | Tentar instalar novamente | Mensagem "already installed" |
| T4.3.4 | Plugin inválido | `verboo plugin validate <path>` em diretório inválido | Erro `invalid_plugin` |

### 4.4 Testes de Enable/Disable

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T4.4.1 | Desabilitar plugin | UI toggle OFF | Plugin desabilitado, skills não injetadas |
| T4.4.2 | Habilitar plugin | UI toggle ON | Plugin habilitado, skills disponíveis |
| T4.4.3 | Desinstalar plugin | UI: "Uninstall" | Plugin removido, dados preservados (keep-data) |

### 4.5 Testes de Marketplace

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T4.5.1 | Marketplace oficial | Verificar `verboo-plugins` listado | Marketplace aparece na lista |
| T4.5.2 | Adicionar marketplace custom | `plugin marketplace add <source>` | Novo marketplace adicionado |
| T4.5.3 | Remover marketplace | `plugin marketplace remove <name>` | Marketplace removido |

### 4.6 Testes de Skills via Plugin

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T4.6.1 | Skills do plugin listadas | Instalar plugin com skills | `list_skills` retorna skills do plugin |
| T4.6.2 | Plugin skill é confiável | Instalar plugin | Skills do plugin têm `trusted=true` |
| T4.6.3 | @plugin-name mention | Digar `@plugin-name` no chat | Skill do plugin ativada |

---

## 5. Vision Fallback (Análise de Imagens)

### 5.1 Pré-requisitos

| Item | Verificação |
|------|-------------|
| Modelo vision-capaz | Pelo menos 1 modelo com `supportsVision: true` |
| Consentimento | `VisionFallbackConsent` não é `Never` |

### 5.2 Testes

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T5.2.1 | Estado do vision fallback | Tauri command `get_vision_fallback_state` | Retorna consentimento e modelo helper |
| T5.2.2 | Consentimento "Ask" | Colar imagem com modelo não-vision | Dialog pede consentimento |
| T5.2.3 | Consentimento "Always" | Aceitar "Always" | Próximas imagens processam sem dialog |
| T5.2.4 | Descrição de imagem | Colar screenshot com modelo não-vision | Modelo vision descreve a imagem |
| T5.2.5 | Cache de visão | Colar mesma imagem 2x | Segunda vez usa cache (SHA-256 hit) |

---

## 6. Browser Panel (Webview Embutido)

### 6.1 Testes

| # | Teste | Passo | Esperado |
|---|-------|-------|----------|
| T6.1.1 | Abrir browser panel | UI: clicar ícone de browser | Painel lateral abre |
| T6.1.2 | Navegar | Digitar URL no browser panel | Página carrega no webview |
| T6.1.3 | Snapshot | Tauri command `browser_snapshot` | Retorna accessibility tree |
| T6.1.4 | Evaluate JS | Tauri command `browser_evaluate_script` | Executa JS, retorna resultado |

---

## 7. Cenários de Integração (E2E)

| # | Cenário | Passos | Esperado |
|---|---------|--------|----------|
| T7.1 | Chat + Browser MCP | 1. Abrir Chrome<br>2. "Navigate to github.com"<br>3. "Take a screenshot"<br>4. "Read the page" | Navega, captura, lê — tudo no chat |
| T7.2 | Chat + Skill | 1. Criar skill com instruções<br>2. Enviar mensagem<br>3. Verificar se skill foi usada | Skill injetada no contexto, modelo a segue |
| T7.3 | Chat + Plugin | 1. Instalar plugin<br>2. Usar @plugin-name<br>3. Verificar resultado | Plugin skill ativada, resposta correta |
| T7.4 | Vision Fallback | 1. Selecionar modelo sem vision<br>2. Colar imagem<br>3. Aceitar consentimento<br>4. Verificar descrição | Imagem descrita via modelo auxiliar |
| T7.5 | Multi-aba Browser | 1. Abrir 3 abas<br>2. Navegar em cada uma<br>3. "List tabs"<br>4. "Switch to tab 2"<br>5. "Take screenshot" | Abas gerenciadas corretamente |

---

## 8. Testes de Performance / Estresse

| # | Teste | Critério |
|---|-------|----------|
| T8.1 | Screenshot rápido | < 3s do prompt à imagem no chat |
| T8.2 | Múltiplos screenshots | 10 screenshots seguidos sem crash |
| T8.3 | Plugin install timeout | Plugin grande instala em < 60s |
| T8.4 | Skill discovery em projeto grande | < 2s para escanear diretório com 50+ skills |
| T8.5 | MCP reconnect | Fechar e reabrir Chrome → MCP reconecta |

---

## 9. Testes de Erro / Edge Cases

| # | Teste | Cenário | Esperado |
|---|-------|---------|----------|
| T9.1 | Chrome fechado | Tentar screenshot sem Chrome | Mensagem de erro clara, não crash |
| T9.2 | Extensão ausente | Chrome sem extensão Verboo | "Extension not found" com instruções |
| T9.3 | Plugin corrupto | Instalar de source inválido | `invalid_plugin` error |
| T9.4 | Skill sem frontmatter | SKILL.md sem YAML | Skill ignorada (não crasha) |
| T9.5 | MCP timeout | Chrome lento para responder | Timeout após 30s, mensagem de erro |
| T9.6 | Auth expirada | Token OAuth expirado | Prompt de re-login |
| T9.7 | Permissão negada | Negar permissão de clique | Turn cancelada, não crash |

---

## Execução

```bash
# 1. Compilar o app
cd C:\Projetos\verboo_app
npm run build:renderer
npx tauri build

# 2. Instalar
# Executar: src-tauri\target\release\bundle\nsis\Verboo Code_0.7.2-beta_x64-setup.exe

# 3. Rodar testes unitários Rust
cd src-tauri
cargo test --lib

# 4. Rodar testes unitários Frontend
cd ..
npm test

# 5. Testes manuais
# Seguir a seção 1-7 acima, interagindo pelo chat do app
```

---

## Checklist de Aprovação

| Sistema | Status |
|---------|--------|
| MCP Browser — Screenshot | ☐ |
| MCP Browser — Navegação | ☐ |
| MCP Browser — Leitura | ☐ |
| MCP iOS Simulator | ☐ (macOS only) |
| Skills — Descoberta | ☐ |
| Skills — Aprovação | ☐ |
| Skills — Injeção | ☐ |
| Plugins — Listagem | ☐ |
| Plugins — Instalação | ☐ |
| Plugins — Enable/Disable | ☐ |
| Vision Fallback | ☐ |
| Browser Panel | ☐ |
| Integração E2E | ☐ |
