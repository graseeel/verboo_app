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
