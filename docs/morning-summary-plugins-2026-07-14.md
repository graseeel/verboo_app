# Resumo da manhã — Plugins (noite 13→14 jul 2026)

## Status
Catálogo **funcional** (tempfile fix). UI polish F1–F5 **implementada**. App buildado em `/Applications/Verboo Code.app`.

## Commits locais (dev, ahead of origin — push se quiser)

| Hash | Mensagem |
|------|----------|
| `7cfc291` | feat(plugins): portal menus, one-click install, dense cards and detail hero |
| `3e76610` | feat(plugins): Codex-inspired detail view and card overflow menu |
| `3f0dc17` | fix(plugins): capture CLI JSON via tempfile to avoid 64KB pipe truncate |
| `39296ac` | fix(plugins): tolerate missing installCount and kind-specific catalog errors |
| `88acbfa` / `627b82e` | marketplace errors + catalog loading copy |
| `f30606f` | chore(release): **0.5.2-beta.1** (já em origin/dev) |

## O que testar

1. **Plugins** na sidebar → instalados + catálogo (muitos cards, seções por marketplace).
2. **⋯** no instalado → menu **não corta** (portal fixed); Atualizar / Ativar|Desativar / Desinstalar.
3. **Instalar** no available → one-click (scope user), spinner no botão, toast; sem modal de escopo.
4. **Click no card** → detail com hero mesh roxo Verboo + monogram.
5. **Busca** filtra.
6. **Gerenciar marketplaces** ainda funciona.
7. Repo sem `marketplace.json` → erro claro (não “plugin inválido” vazio).

## Comportamento esperado
- Catálogo: CLI via arquivo temp (sem truncar 64KB pipe).
- Install: padrão usuário, rápido, loading no botão (estilo Codex, sem OAuth).
- Cards: monogram colorido (não logos oficiais — CLI não envia), Install ghost.
- Detail: hero CSS Verboo (não assets Codex).

## Fora de escopo (ainda)
- `@` para plugins (sem contract)
- OAuth/conectores tipo ClickUp
- Logos oficiais remotas
- “Testar agora” com prefill no chat
- Tabs Plugins | Habilidades / MCPs

## Bom dia ☀️
