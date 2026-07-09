# Instalação — Verboo Code (macOS Apple Silicon)

O Verboo Code é um app **independente** para Macs com chip **Apple Silicon (M1 ou superior)**, construído com Tauri v2 (backend Rust + WebView nativo do sistema).
Você **não** precisa ter Node.js, npm nem o CLI do Verboo instalados — o app já vem completo com o `cli-package` sidecar embutido.

## Requisitos

- macOS 12 (Monterey) ou superior
- Mac com Apple Silicon (M1, M2, M3, M4…) — builds Intel não são suportados

## Primeira abertura (passo importante)

O app ainda **não é assinado/notarizado pela Apple** (conta de desenvolvedor em andamento).
Por isso, na primeira vez, o macOS pode bloquear com uma mensagem como:

> _"Verboo Code está danificado e não pode ser aberto."_
> _"…não pode ser aberto porque a Apple não pode verificá-lo."_

Isso é **esperado** e **não** significa que o app está com problema — é só o Gatekeeper do macOS
protegendo contra apps sem assinatura. Para liberar:

1. Mova o **Verboo Code.app** para a pasta **Aplicativos** (ou onde preferir).
2. Abra o **Terminal** e rode o comando abaixo (ajuste o caminho se o app estiver em outro lugar):

   ```bash
   xattr -cr "/Applications/Verboo Code.app"
   ```

3. Abra o app normalmente (duplo clique).

> A partir daí ele abre direto — o passo acima só é necessário uma vez.

### Alternativa (sem Terminal)

Clique com o **botão direito** no app → **Abrir** → **Abrir** na janela de confirmação.
Se ainda aparecer "danificado", use o método do `xattr` acima — é o mais confiável.

## O que NÃO é necessário

- ❌ Node.js / npm
- ❌ CLI global do Verboo (`verboo`)
- ✅ O bundle Tauri já vem com o backend Rust, o `cli-package` (CLI Verboo + dependências Node) e os módulos nativos embutidos.

## Primeiro uso

Ao abrir, faça login com sua conta Verboo pela própria interface do app. Pronto.
