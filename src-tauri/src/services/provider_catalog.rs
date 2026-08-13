//! provider_catalog.rs — discovery de modelos e estado de autenticação dos
//! provedores (claude/codex) via CLI empacotado.
//!
//! F2-PROVIDERS: a ponte usa SEMPRE o CLI empacotado (CliSpawn: node_runtime
//! + cli.mjs), nunca o `verboo` global. Se a listagem falhar, o chamador
//! degrada para o catálogo atual (provider = "verboo" implícito) — a
//! feature degrada, o app não quebra.
//!
//! A fronteira serde já foi mordida três vezes — o teste de parse usa a
//! SAÍDA REAL do CLI 0.15.2 (medição do Prumo) como fixture literal e
//! campos desconhecidos são ignorados sem erro (serde sem
//! deny_unknown_fields).

use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::models::types::{ModelReasoning, VerbooModel};
use crate::services::cli_spawn::CliSpawn;

const CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// Uma linha da listagem `--list-models` do CLI (JSON por linha, 0.15.2).
/// Shape medido pelo Prumo: provider, id, displayName, contextWindow,
/// defaultReasoningLevel, supportedReasoningLevels.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliModelLine {
    pub provider: String,
    pub id: String,
    pub display_name: String,
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_levels: Option<Vec<String>>,
}

/// Estado de autenticação do CLI (`auth status`). Encapsulado num ponto só —
/// o auth status --json com providers foi pedido ao time do CLI; quando a
/// leitura trocar, é só este módulo que muda.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthState {
    pub logged_in: bool,
    pub auth_method: String,
    pub api_provider: String,
}

/// Lista os modelos de provedor via `--list-models` do CLI empacotado.
/// Err (não autenticado, CLI ausente, timeout, zero modelos) → o
/// chamador degrada para o catálogo atual.
pub fn list_provider_models() -> Result<Vec<VerbooModel>, String> {
    let stdout = run_cli(&["--list-models"], "--list-models")?;
    let models = parse_models_stdout(&stdout);
    if models.is_empty() {
        // A saída real de CLI não-autenticado é uma linha de TEXTO (não JSON):
        // "Não autenticado no Verboo. Execute `verboo /login` em um terminal
        // interativo antes de usar o modo headless." — isso NÃO é um catálogo
        // vazio; é a falha de auth. Reportar para o chamador degradar.
        return Err(
            "O CLI não retornou modelos de provedor (possivelmente não autenticado no Verboo)."
                .into(),
        );
    }
    Ok(models)
}

/// Parse do stdout de `--list-models`. Aceita DOIS formatos:
/// (a) ARRAY JSON pretty-printed — o formato REAL do CLI 0.15.2 autenticado
///     (multi-linha, começa com `[`, termina com `]`; 17 modelos, 9 verboo +
///     8 codex). O parser antigo só aceitava (b) — nenhuma linha isolada do
///     array é JSON válido => models vazio => degrada para verboo-only. Por
///     isso o grupo Codex sumiu do seletor.
/// (b) JSON-por-linha (fallback — uma linha = um objeto JSON; formato que
///     o Prumo mediu numa versão anterior). Mantido por segurança — não
///     sabemos se o formato varia por versão/TTY.
fn parse_models_stdout(stdout: &str) -> Vec<VerbooModel> {
    let trimmed = stdout.trim();
    // (a) Tenta o array primeiro (formato real do CLI autenticado).
    if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(trimmed)
    {
        return arr
            .into_iter()
            .filter_map(|item| serde_json::from_value::<CliModelLine>(item).ok())
            .map(to_verboo_model)
            .collect();
    }
    // (b) Fallback: JSON-por-linha.
    stdout
        .lines()
        .filter_map(|line| parse_cli_line(line))
        .map(to_verboo_model)
        .collect()
}

/// Lê o estado de autenticação do CLI (`auth status`) — a fonte que o CLI
/// expõe HOJE. Mesmo ponto de leitura usado pela ponte de login (F4).
pub fn read_provider_auth_state() -> Result<ProviderAuthState, String> {
    let stdout = run_cli(&["auth", "status"], "auth status")?;
    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!("Falha ao decodificar o estado de autenticação: {e}")
    })
}

/// Desloga o provedor pelo MECANISMO QUE O CLI USA: o CLI tem o slash
/// `/logout` (atalho de `auth logout`) e o `auth logout` é não-interativo
/// (verificado com o CLI 0.15.2) — limpa o token local do CLI. Idempotente:
/// deslogar uma conta já deslogada não é erro.
///
/// O comando Tauri `provider_logout` foi REMOVIDO (o logout global do CLI
/// não pode ficar alcançável pelo renderer). Esta utility fica testada e
/// REVIVE quando o CLI entregar o logout por provedor — aí o comando volta
/// com o provider real.
pub fn logout_provider() -> Result<(), String> {
    let _stdout = run_cli(&["auth", "logout"], "auth logout")?;
    Ok(())
}

/// Lê o blob de credenciais do CLI (keychain) — fonte da evidência de
/// conexão POR PROVEDOR. O blob guarda token por provedor
/// (`{ codex: {...}, claude: {...} }`); quando o time do CLI entregar o
/// `auth status --json` por provedor, esta leitura troca (encapsulada aqui).
pub fn read_provider_credentials_blob() -> Option<serde_json::Value> {
    crate::services::cli_credentials::read_provider_credentials_blob()
}

/// Ponto ÚNICO de mapeamento provider→chave de storage do CLI. O blob do
/// keychain guarda token POR PROVEDOR sob a chave que o CLI define — NÃO
/// sob o provider id do app. Medido no clone verboo-cli:
///   - `CODEX_STORAGE_KEY = 'codex'`        (codexCredentials.ts:13)
///   - `CLAUDE_NATIVE_STORAGE_KEY = 'claudeNative'` (claudeNativeCredentials.ts:11)
/// Shape completo em `secureStorage/index.ts:SecureStorageData` (codex,
/// claudeNative, verbooOauth, verbooInstallationId, mcpOAuth…).
///
/// ESTRICT: não aceitar `"claude"` como fallback — aceitar as duas chaves
/// esconderia um drift futuro de novo. Provider desconhecido → None (o
/// chamador degrada para false).
pub fn cli_storage_key(provider: &str) -> Option<&'static str> {
    match provider {
        "codex" => Some("codex"),
        "claude" => Some("claudeNative"),
        _ => None,
    }
}

/// Evidência de conexão DAQUELE provedor: o blob de credenciais do CLI
/// guarda token POR PROVEDOR sob a chave de storage do CLI (NÃO o provider
/// id do app — `cli_storage_key`). connected = a entrada daquele provedor
/// existe no blob e é não-nula. NUNCA o estado global (o loggedIn global é
/// da sessão Verboo, não do provedor — espalhá-lo fez o cartão mentir
/// "Conectado" sem o dono nunca conectar).
pub fn provider_connected_from_blob(provider: &str, blob: &serde_json::Value) -> bool {
    cli_storage_key(provider)
        .and_then(|key| blob.get(key))
        .map(|entry| !entry.is_null())
        .unwrap_or(false)
}

/// Snapshot canônico do estado de login DO provedor para o poll da ponte
/// (`provider_login_pty`). Duas partes:
///
/// 1. **Chave token** (`cli_storage_key`) — o token do provedor no blob,
///    NORMALIZADO SEM os voláteis de refresh (`lastRefreshAt`,
///    `lastRefreshFailureAt`, `lastValidatedAt`): um refresh de fundo que só
///    mexe nesses campos não pode parecer "conta nova".
/// 2. **Registro de contas** (`providerAccounts.<provider>`) — normalizado
///    para identidade estável: `defaultAccountId` + map
///    `localAccountId → providerSubjectId`. Credential, planId, displayLabel
///    e voláteis são descartados.
///
/// O poll emite Connected quando QUALQUER parte muda do snapshot capturado
/// no momento do slash:
/// - 1º login: token `null` → Some;
/// - 2ª conta NÃO-default: o registro ganha uma conta sem a chave token mudar
///   (o CLI 0.15.12 aditivo espelha a conta DEFAULT na chave token via
///   `mirrorDefaultCredential` — evidência real 2026-08-10: `codex` == conta
///   default, a 2ª conta só no `providerAccounts`);
/// - reconnect: a chave token muda;
/// - refresh de fundo (só voláteis): nada muda — a guarda obrigatória.
pub fn provider_login_state_snapshot(
    provider: &str,
    blob: &serde_json::Value,
) -> serde_json::Value {
    let token = cli_storage_key(provider)
        .and_then(|key| blob.get(key))
        .map(|entry| match entry.as_object() {
            Some(obj) => {
                let mut normalized = obj.clone();
                normalized.remove("lastRefreshAt");
                normalized.remove("lastRefreshFailureAt");
                normalized.remove("lastValidatedAt");
                serde_json::Value::Object(normalized)
            }
            None => entry.clone(),
        });
    let accounts = blob
        .get("providerAccounts")
        .and_then(|registry| registry.get(provider))
        .map(|section| {
            let default_account_id = section
                .get("defaultAccountId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut account_ids = serde_json::Map::new();
            if let Some(items) = section.get("accounts").and_then(|v| v.as_object()) {
                for (local_id, account) in items {
                    let subject = account.get("providerSubjectId").and_then(|v| v.as_str());
                    account_ids.insert(
                        local_id.clone(),
                        match subject {
                            Some(subject) => serde_json::Value::String(subject.to_string()),
                            None => serde_json::Value::Null,
                        },
                    );
                }
            }
            serde_json::json!({
                "defaultAccountId": default_account_id,
                "accounts": serde_json::Value::Object(account_ids),
            })
        });
    serde_json::json!({
        "token": token,
        "accounts": accounts,
    })
}

/// Parse de uma linha da listagem. Linhas não-JSON (erros, ruído) → None.
fn parse_cli_line(line: &str) -> Option<CliModelLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// Normaliza uma linha do CLI para o modelo serializado do app. O contrato
/// atual de `--list-models` não informa visão, portanto essa capacidade fica
/// desconhecida. Apenas metadado explícito do Router pode promover o badge;
/// assumir `true` aqui faria todos os modelos Claude/Codex parecerem visuais.
fn to_verboo_model(line: CliModelLine) -> VerbooModel {
    let reasoning = line
        .supported_reasoning_levels
        .as_ref()
        .filter(|levels| !levels.is_empty())
        .map(|levels| ModelReasoning {
            effort_levels: levels.clone(),
            default_effort: line.default_reasoning_level.clone(),
        });
    VerbooModel {
        id: line.id.clone(),
        display_name: line.display_name.clone(),
        context_window: line.context_window,
        max_output_tokens: None,
        supports_vision: None,
        vision_support_source: None,
        reasoning,
        provider: Some(line.provider.clone()),
        raw: serde_json::json!({
            "provider": line.provider,
            "id": line.id,
            "displayName": line.display_name,
            "contextWindow": line.context_window,
            "defaultReasoningLevel": line.default_reasoning_level,
            "supportedReasoningLevels": line.supported_reasoning_levels,
        }),
    }
}

/// Roda o CLI empacotado com args e coleta o stdout (timeout honesto).
fn run_cli(args: &[&str], label: &str) -> Result<String, String> {
    let spawn = CliSpawn::new(args.iter().copied());
    let mut cmd = spawn.command;
    // A2-FIX3: todo spawn de produção entra no próprio process group (os
    // creation_flags do Windows já vêm do CliSpawn::new) — o cancelamento
    // da ponte de login (F4) mata o grupo inteiro sem órfãos.
    crate::services::child_signal::configure_process_group(&mut cmd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao iniciar o CLI ({label}): {e}"))?;

    // Drena o stderr numa thread para o child nunca travar no pipe cheio.
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for _line in reader.lines() {
                // Descartado — só precisamos garantir o drain.
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "CLI stdout indisponível".to_string())?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut out = String::new();
        for line in reader.lines() {
            if let Ok(line) = line {
                out.push_str(&line);
                out.push('\n');
            }
        }
        let _ = tx.send(out);
    });

    let start = Instant::now();
    loop {
        if let Ok(out) = rx.try_recv() {
            let _ = child.kill();
            return Ok(out);
        }
        if start.elapsed() > CLI_TIMEOUT {
            let _ = child.kill();
            return Err(format!("O CLI ({label}) excedeu o tempo limite."));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture do shape REAL do registro de contas do CLI 0.15.12
    /// (evidência do keychain 2026-08-10): defaultAccountId + accounts map
    /// com providerSubjectId/credential/voláteis.
    fn blob_com_contas(account_ids: &[(&str, &str)]) -> serde_json::Value {
        let mut accounts = serde_json::Map::new();
        for (local_id, subject) in account_ids {
            accounts.insert(
                (*local_id).to_string(),
                serde_json::json!({
                    "localAccountId": local_id,
                    "providerSubjectId": subject,
                    "displayLabel": "Codex",
                    "connectionState": "connected",
                    "credential": { "accessToken": format!("tok-{subject}"), "lastRefreshAt": 1000 },
                    "lastValidatedAt": "2026-08-10T00:00:00.000Z",
                }),
            );
        }
        serde_json::json!({
            "codex": {
                "accessToken": "tok-default", "refreshToken": "ref-default",
                "accountId": account_ids.first().map(|(_, s)| *s).unwrap_or(""),
                "idToken": "id-default", "lastRefreshAt": 1000, "lastRefreshFailureAt": 0,
            },
            "providerAccounts": {
                "schemaVersion": 1,
                "codex": {
                    "defaultAccountId": account_ids.first().map(|(id, _)| *id).unwrap_or(""),
                    "accounts": accounts,
                }
            }
        })
    }

    #[test]
    fn provider_login_state_snapshot_normalizes_registry_to_stable_identity() {
        let blob = blob_com_contas(&[("local-a", "subj-a"), ("local-b", "subj-b")]);
        let snap = provider_login_state_snapshot("codex", &blob);
        // Chave token: voláteis de refresh REMOVIDOS.
        assert!(snap["token"].get("lastRefreshAt").is_none());
        assert!(snap["token"].get("lastRefreshFailureAt").is_none());
        assert!(snap["token"].get("accessToken").is_some());
        // Registro: só identidade estável.
        assert_eq!(snap["accounts"]["defaultAccountId"], "local-a");
        assert_eq!(snap["accounts"]["accounts"]["local-a"], "subj-a");
        assert_eq!(snap["accounts"]["accounts"]["local-b"], "subj-b");
        // Voláteis/credential não vazam para o snapshot.
        assert!(snap["accounts"]["accounts"]["local-a"].get("credential").is_none());
        assert!(snap["accounts"].get("lastValidatedAt").is_none());
    }

    #[test]
    fn provider_login_state_snapshot_ignores_volatile_only_changes() {
        let antes = blob_com_contas(&[("local-a", "subj-a")]);
        let mut depois = antes.clone();
        // Refresh de fundo: só os voláteis mudam (token key + registro).
        depois["codex"]["lastRefreshAt"] = serde_json::json!(9999);
        depois["codex"]["lastRefreshFailureAt"] = serde_json::json!(1);
        depois["providerAccounts"]["codex"]["accounts"]["local-a"]["credential"]
            ["lastRefreshAt"] = serde_json::json!(9999);
        depois["providerAccounts"]["codex"]["accounts"]["local-a"]["lastValidatedAt"] =
            serde_json::json!("2026-08-11T00:00:00.000Z");
        assert_eq!(
            provider_login_state_snapshot("codex", &antes),
            provider_login_state_snapshot("codex", &depois),
            "refresh de fundo (só lastRefreshAt/lastValidatedAt) NÃO pode mudar o snapshot"
        );
    }

    #[test]
    fn provider_login_state_snapshot_detects_registry_account_gain_without_token_change() {
        // 2ª conta NÃO-default: o registro ganha a conta B, a chave token
        // NÃO muda (espelhada na conta default pelo CLI aditivo 0.15.12).
        let antes = blob_com_contas(&[("local-a", "subj-a")]);
        let depois = blob_com_contas(&[("local-a", "subj-a"), ("local-b", "subj-b")]);
        assert_eq!(antes["codex"], depois["codex"], "chave token inalterada");
        assert_ne!(
            provider_login_state_snapshot("codex", &antes),
            provider_login_state_snapshot("codex", &depois),
            "o registro ganhou a conta B → o snapshot DEVE mudar → Connected"
        );
    }

    #[test]
    fn provider_login_state_snapshot_first_login_token_null_to_some() {
        let antes = serde_json::json!({});
        let depois = blob_com_contas(&[("local-a", "subj-a")]);
        assert_ne!(
            provider_login_state_snapshot("codex", &antes),
            provider_login_state_snapshot("codex", &depois),
            "1º login: token null → Some é mudança → Connected"
        );
    }

    /// Fixture LITERAL do shape da listagem (medição do Prumo, CLI 0.15.2):
    /// provider, id, displayName, contextWindow, defaultReasoningLevel,
    /// supportedReasoningLevels — + um campo desconhecido que deve ser
    /// ignorado SEM erro.
    const PRUMO_LIST_MODEL_LINE: &str = r#"{"provider":"codex","id":"codex-opus-4-6","displayName":"Codex Opus 4.6","contextWindow":200000,"defaultReasoningLevel":"medium","supportedReasoningLevels":["none","low","medium","high"],"futureField":{"nested":true}}"#;

    /// A saída REAL capturada do CLI não-autenticado (listmodels-0.15.2.txt
    /// do sandbox do Prumo) — linha de texto, NUNCA JSON.
    const PRUMO_UNAUTHENTICATED_LINE: &str =
        "Não autenticado no Verboo. Execute `verboo /login` em um terminal interativo antes de usar o modo headless.";

    /// A saída REAL do `auth status` (authstatus-0152.json do Prumo,
    /// reproduzida com o CLI 0.15.2 do sandbox).
    const PRUMO_AUTH_STATUS: &str = r#"{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}"#;

    #[test]
    fn parse_cli_line_prumo_shape_and_unknown_fields_ignored() {
        let parsed = parse_cli_line(PRUMO_LIST_MODEL_LINE).expect("a linha real do Prumo deve parsear");
        assert_eq!(parsed.provider, "codex");
        assert_eq!(parsed.id, "codex-opus-4-6");
        assert_eq!(parsed.display_name, "Codex Opus 4.6");
        assert_eq!(parsed.context_window, Some(200000));
        assert_eq!(parsed.default_reasoning_level.as_deref(), Some("medium"));
        assert_eq!(
            parsed.supported_reasoning_levels,
            Some(vec!["none".to_string(), "low".to_string(), "medium".to_string(), "high".to_string()])
        );
    }

    #[test]
    fn parse_cli_line_rejects_non_json_lines_without_panicking() {
        assert!(parse_cli_line(PRUMO_UNAUTHENTICATED_LINE).is_none());
        assert!(parse_cli_line("").is_none());
        assert!(parse_cli_line("   ").is_none());
    }

    #[test]
    fn to_verboo_model_keeps_provider_vision_unknown_without_authoritative_metadata() {
        let parsed = parse_cli_line(PRUMO_LIST_MODEL_LINE).unwrap();
        let model = to_verboo_model(parsed);
        assert_eq!(model.provider.as_deref(), Some("codex"));
        assert_eq!(
            model.supports_vision, None,
            "o CLI nao informa visão; o app nao pode inventar suporte"
        );
        assert_eq!(model.vision_support_source, None);
        assert_eq!(model.id, "codex-opus-4-6");
        assert_eq!(model.display_name, "Codex Opus 4.6");
    }

    #[test]
    fn to_verboo_model_maps_reasoning_levels() {
        let parsed = parse_cli_line(PRUMO_LIST_MODEL_LINE).unwrap();
        let model = to_verboo_model(parsed);
        let reasoning = model.reasoning.expect("níveis de raciocínio devem ser promovidos");
        assert_eq!(reasoning.effort_levels, vec!["none", "low", "medium", "high"]);
        assert_eq!(reasoning.default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn serialized_provider_model_shape_matches_renderer_contract() {
        let parsed = parse_cli_line(PRUMO_LIST_MODEL_LINE).unwrap();
        let model = to_verboo_model(parsed);
        let json = serde_json::to_value(&model).unwrap();
        assert_eq!(json["provider"], "codex", "provider serializado em camelCase");
        assert_eq!(json["id"], "codex-opus-4-6");
        assert_eq!(json["displayName"], "Codex Opus 4.6");
        assert!(json["supportsVision"].is_null());
        assert!(json["visionSupportSource"].is_null());
        assert_eq!(json["reasoning"]["defaultEffort"], "medium");

        // Modelo Verboo (provider None) → campo AUSENTE no serializado:
        // o renderer trata ausente como "verboo" (contrato atual intacto).
        let mut verboo = to_verboo_model(parse_cli_line(PRUMO_LIST_MODEL_LINE).unwrap());
        verboo.provider = None;
        let verboo_json = serde_json::to_value(&verboo).unwrap();
        assert!(
            !verboo_json.as_object().unwrap().contains_key("provider"),
            "provider ausente = verboo implícito: {verboo_json}"
        );
    }

    #[test]
    fn auth_state_parses_real_cli_output() {
        let state: ProviderAuthState =
            serde_json::from_str(PRUMO_AUTH_STATUS).expect("a saída real do auth status deve parsear");
        assert_eq!(state.logged_in, false);
        assert_eq!(state.auth_method, "none");
        assert_eq!(state.api_provider, "firstParty");
    }

    /// Serializa os testes que mexem em VERBOO_CLI_PATH (env global).

    fn write_fake_cli(stdout_body: &str, suffix: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verboo-provider-fake-cli-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli.mjs");
        let script = format!("console.log({stdout_body:?});\n");
        std::fs::write(&path, script).unwrap();
        // SAFETY: env var global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("VERBOO_CLI_PATH", &path);
        }
        path
    }

    fn clear_fake_cli() {
        unsafe {
            std::env::remove_var("VERBOO_CLI_PATH");
        }
    }

    #[test]
    fn list_provider_models_parses_multiline_stdout() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_fake_cli(
            r#"{"provider":"codex","id":"codex-opus-4-6","displayName":"Codex Opus 4.6","contextWindow":200000}
{"provider":"claude","id":"claude-sonnet-4-6","displayName":"Claude Sonnet 4.6","contextWindow":200000}"#,
            "multiline",
        );
        let models = list_provider_models().expect("duas linhas JSON devem parsear");
        clear_fake_cli();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].provider.as_deref(), Some("codex"));
        assert_eq!(models[1].provider.as_deref(), Some("claude"));
    }

    /// D1: o CLI 0.15.2 autenticado emite um ARRAY JSON pretty-printed
    /// (multi-linha), NAO json-por-linha. O parser antigo (stdout.lines() +
    /// from_str por linha) nao parseava nenhuma linha isolada => models vazio
    /// => degrada para verboo-only. Por isso o grupo Codex sumiu do seletor.
    /// Fixture com o shape real (capturado do CLI empacotado autenticado).
    #[test]
    fn list_provider_models_parses_pretty_printed_array() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_fake_cli(
            r#"[
  {
    "provider": "codex",
    "id": "gpt-5.6-sol",
    "displayName": "GPT-5.6 Sol",
    "contextWindow": 272000,
    "defaultReasoningLevel": "low",
    "supportedReasoningLevels": ["none", "low", "medium", "high"]
  },
  {
    "provider": "verboo",
    "id": "ultra/deepseek-v4-flash",
    "displayName": "Ultra (deepseek-v4-flash)",
    "contextWindow": 128000
  }
]"#,
            "array",
        );
        let models = list_provider_models().expect("o array pretty-printed deve parsear");
        clear_fake_cli();
        assert_eq!(models.len(), 2, "um codex + um verboo");
        let codex = models.iter().find(|m| m.provider.as_deref() == Some("codex")).expect("codex presente");
        assert_eq!(codex.id, "gpt-5.6-sol");
        assert_eq!(codex.context_window, Some(272000));
        let reasoning = codex.reasoning.as_ref().expect("reasoning promovido");
        assert_eq!(reasoning.default_effort.as_deref(), Some("low"));
        let verboo = models.iter().find(|m| m.provider.as_deref() == Some("verboo")).expect("verboo presente");
        assert_eq!(verboo.id, "ultra/deepseek-v4-flash");
    }

    #[test]
    fn list_provider_models_unauthenticated_output_is_error() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_fake_cli(PRUMO_UNAUTHENTICATED_LINE, "unauth");
        let error = list_provider_models().unwrap_err();
        clear_fake_cli();
        assert!(
            error.contains("não autenticado") || error.contains("não retornou modelos"),
            "a saída real de não-autenticado deve virar erro de degradação: {error}"
        );
    }

    #[test]
    fn read_provider_auth_state_parses_real_output() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_fake_cli(
            r#"{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}"#,
            "auth",
        );
        let state = read_provider_auth_state().expect("a saída real do auth status deve parsear");
        clear_fake_cli();
        assert!(!state.logged_in);
        assert_eq!(state.auth_method, "none");
    }

    #[test]
    fn logout_provider_calls_the_cli_auth_logout() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "verboo-provider-fake-cli-{}-logout",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli.mjs");
        let marker = dir.join("logout-called");
        let script = format!(
            "import fs from 'node:fs';\nif (process.argv[2] === 'auth' && process.argv[3] === 'logout') {{\n  fs.writeFileSync({marker:?}, '1');\n  console.log('Successfully logged out');\n  process.exit(0);\n}}\nconsole.log('noop');\n"
        );
        std::fs::write(&path, script).unwrap();
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("VERBOO_CLI_PATH", &path);
        }
        logout_provider().expect("o logout deve resolver");
        clear_fake_cli();
        assert!(
            marker.exists(),
            "o auth logout do CLI deve ter sido chamado — o mecanismo que o CLI usa"
        );
    }

    /// Ponto único de mapeamento: provider id do app → chave de storage do
    /// CLI. Medido no clone verboo-cli (codexCredentials.ts:13,
    /// claudeNativeCredentials.ts:11). ESTRICT: "claude" NÃO mapeia para
    /// "claude" — mapeia para "claudeNative". Aceitar os dois esconderia
    /// um drift futuro.
    #[test]
    fn cli_storage_key_maps_app_provider_to_cli_key() {
        assert_eq!(cli_storage_key("codex"), Some("codex"));
        assert_eq!(cli_storage_key("claude"), Some("claudeNative"));
        assert_eq!(cli_storage_key("unknown"), None);
    }

    /// provider_connected_from_blob usa cli_storage_key (NÃO o provider id).
    /// Fixture capturada do blob real: claudeNative presente, claude
    /// AUSENTE. Se o código usasse o provider id direto, claude ficaria
    /// false (o defeito que o dono viu — cartão nunca acende).
    #[test]
    fn provider_connected_from_blob_uses_cli_storage_key_not_provider_id() {
        let blob = serde_json::json!({
            "codex": null,
            "claudeNative": {
                "accessToken": "tok",
                "accountId": "acct-42",
            },
            "verbooOauth": { "accessToken": "verboo-tok" },
            "verbooInstallationId": "inst-1"
        });
        // claude → claudeNative (presente) → true
        assert!(
            provider_connected_from_blob("claude", &blob),
            "claude mapeia para claudeNative (presente) → true"
        );
        // codex → codex (null) → false
        assert!(
            !provider_connected_from_blob("codex", &blob),
            "codex null no blob → false"
        );
        // provider desconhecido → false
        assert!(
            !provider_connected_from_blob("unknown", &blob),
            "provider desconhecido → false"
        );
        // A chave "claude" NÃO existe no blob — se o código usasse o
        // provider id direto, claude seria false. Esta asserção crava
        // que o mapeamento está ativo.
        assert!(
            blob.get("claude").is_none(),
            "a chave 'claude' NAO existe no blob real — o mapeamento e obrigatorio"
        );
    }
}
