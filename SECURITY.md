# Security Policy

## Supported Status

This app is an independent development build and should be treated as experimental.

## Reporting a Vulnerability

Please do not open public issues that contain API keys, account data, private logs, file paths with sensitive information, or security exploit details.

Send sensitive reports directly to:

- Email: grasel.moura05@gmail.com
- X: @grrL_

For regular bugs or non-sensitive feedback, use the in-app feedback form.

## Secrets

Never commit:

- Verboo API keys
- Supabase service-role keys
- Supabase database passwords
- Apple signing certificates
- Provisioning profiles
- `.env` files with real values

## High-Trust Mode

The app can run the underlying Verboo CLI with broad local-machine permissions depending on the selected access mode. Users should only enable full access in trusted projects and machines.

## Português (Brasil)

### Status de suporte

Este app é um build independente em desenvolvimento e deve ser tratado como experimental.

### Reportando uma vulnerabilidade

Não abra issues públicas contendo chaves de API, dados de conta, logs privados, caminhos de arquivo com informação sensível ou detalhes de exploits.

Envie relatos sensíveis diretamente para:

- E-mail: grasel.moura05@gmail.com
- X: @grrL_

Para bugs comuns ou feedback não sensível, use o formulário de feedback dentro do app.

### Segredos

Nunca commite:

- Chaves de API do Verboo
- Chaves service-role do Supabase
- Senhas de banco do Supabase
- Certificados de assinatura da Apple
- Provisioning profiles
- Arquivos `.env` com valores reais

### Modo de alta confiança

O app pode executar o Verboo CLI com permissões amplas na máquina local, dependendo do modo de acesso selecionado. Habilite acesso total apenas em projetos e máquinas confiáveis.
