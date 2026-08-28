//! provider_login_pty.rs — ponte de login por PSEUDO-TERMINAL (F4).
//!
//! O login de provedor (ex.: codex/claude) hoje exige SO slash interativo
//! (`/codex login`, `/claude login`). Esta ponte spawna o CLI EMPACOTADO
//! (CliSpawn: node_runtime + cli.mjs, nunca o `verboo` global) num PTY,
//! espera o prompt interativo ficar PRONTO (telas de primeira execução
//! existem — nunca digita no vazio), envia o slash, e daí em diante quem
//! trabalha é o CLI (navegador + callback local).
//!
//! O sucesso é detectado FORA da tela: o blob local continua como fast path,
//! e o protocolo sanitizado `provider-accounts list` do próprio CLI confirma
//! autoritativamente a conta nova. Nunca parseamos o texto do TUI. Timeout
//! honesto: se o usuário fechar o navegador, voltamos para erro — não
//! penduramos. O cancelamento mata o process group inteiro do PTY (o child é
//! session leader) — sem órfãos, como no WDA.
//!
//! Quando o time do CLI entregar o comando não-interativo (pedido formal já
//! enviado), esta ponte SAI — o módulo é isolado de propósito para a
//! remoção ser barata.

use std::collections::BTreeSet;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use uuid::Uuid;

use crate::services::cli_spawn::{CliRuntime, CliSpawn};
use crate::services::provider_accounts::{self, ProviderAccountSummary};
use crate::services::provider_catalog;
use crate::services::terminal_service::strip_terminal_controls;

/// Prazo honesto do login: o usuário pode fechar o navegador a qualquer
/// momento — voltamos para erro com mensagem, não penduramos.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
/// Prazo na fase de browser (awaiting emitido): o usuário pode demorar no
/// OAuth (2º e-mail, senha, MFA) — 10 min honestos. O login_timeout (180s)
/// vale ANTES do navegador abrir; depois dele o browser_timeout assume
/// (evidência D: o CLI era morto no redirect do browser — ERR_CONNECTION_REFUSED).
const BROWSER_TIMEOUT: Duration = Duration::from_secs(600);
/// O CLI interativo pode mostrar telas de primeira execução antes do prompt.
const PROMPT_READY_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const PROVIDER_LOGIN_CONFIRMATION_FAILED: &str = "provider_login_confirmation_failed";
/// Uma falha isolada pode ser transitória (processo do CLI ainda encerrando o
/// callback OAuth). Três falhas consecutivas encerram com código sanitizado,
/// muito antes do browser timeout de 10 minutos.
const PROVIDER_ACCOUNTS_FAILURE_LIMIT: u8 = 3;
/// Intervalo entre a seta de navegação e o Enter em menus do TUI. O Ink NÃO
/// processa a navegação quando os dois chegam colados no mesmo write — o
/// Enter cai na opção PADRÃO (2 = Cancelar). Prova A/B do dono no CLI real:
/// colados cancela, separados avança ao OAuth. Mesma família do \n vs \r: o
/// terminal real exige o ritmo, não só os bytes. 0.3s medido no probe B.
const MENU_NAV_INTERVAL: Duration = Duration::from_millis(300);

/// Shape do evento de login — contrato COMBINADO com o time do CLI e já
/// consumido pelo Mosaico no canal `provider-login:event`:
/// `{ provider, state, message? }` com state em snake_case.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderLoginEvent {
    pub provider: String,
    pub state: ProviderLoginState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderLoginState {
    AwaitingBrowser,
    Connected,
    Error,
    /// Tela de aceite de risco (ex.: o /claude login mostra o aviso da
    /// Anthropic sobre OAuth de terceiros). A ponte NUNCA aceita risco
    /// sozinha — para na tela, emite o evento com o texto, e só segue após
    /// provider_login_confirm_risk.
    RiskNotice,
}

/// Universo de provedores que a PONTE suporta — os slash commands que ela
/// digita (`/codex login`, `/claude login`). É a única fonte verdadeira
/// HOJE.
///
/// CONTRATO DE REMOÇÃO DA PONTE: quando o time do CLI entregar o
/// `auth status --json` por provedor, este universo passa a vir da
/// LISTAGEM do CLI (a mesma do F2) e a troca acontece SÓ aqui no backend —
/// o renderer continua consumindo o shape `{ provider, connected,
/// account? }` sem mudança. O ProviderAuthState global (sem provider) é
/// detalhe interno da leitura e não fala com o renderer.
pub const SUPPORTED_PROVIDERS: &[&str] = &["codex", "claude"];

/// Estado de autenticação POR PROVEDOR — o shape que fala com o renderer.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderAuthStatus {
    pub provider: String,
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

/// Estado de autenticação por provedor: uma entrada por provedor que a
/// ponte suporta. A fonte de `connected` é a EVIDÊNCIA DAQUELE provedor:
/// o blob de credenciais do CLI guarda token POR PROVEDOR (medido no clone
/// verboo-cli) — `connected` = a entrada daquele provedor existe. O estado
/// GLOBAL (`auth status`) é da sessão Verboo, NUNCA do provedor — espalhá-lo
/// fez o cartão mentir "Conectado" (defeito de campo). Quando o CLI entregar
/// o auth status por provedor, a leitura troca SÓ neste módulo (ver
/// CONTRATO DE REMOÇÃO acima).
pub fn provider_auth_status() -> Result<Vec<ProviderAuthStatus>, String> {
    let blob =
        provider_catalog::read_provider_credentials_blob().unwrap_or_else(|| serde_json::json!({}));
    Ok(provider_auth_status_from_blob(&blob))
}

/// A função pura do shape por provedor (testável com blobs de fixture).
pub fn provider_auth_status_from_blob(blob: &serde_json::Value) -> Vec<ProviderAuthStatus> {
    SUPPORTED_PROVIDERS
        .iter()
        .map(|provider| {
            let connected = provider_catalog::provider_connected_from_blob(provider, blob);
            let account = provider_catalog::cli_storage_key(provider)
                .and_then(|key| blob.get(key))
                .and_then(|entry| entry.get("accountId"))
                .and_then(|v| v.as_str())
                .map(String::from);
            ProviderAuthStatus {
                provider: (*provider).to_string(),
                connected,
                account,
            }
        })
        .collect()
}

/// Timeouts configuráveis (os testes usam os curtos).
#[derive(Debug, Clone, Copy)]
pub struct LoginOptions {
    pub prompt_timeout: Duration,
    pub login_timeout: Duration,
    pub browser_timeout: Duration,
}

impl Default for LoginOptions {
    fn default() -> Self {
        Self {
            prompt_timeout: PROMPT_READY_TIMEOUT,
            login_timeout: LOGIN_TIMEOUT,
            browser_timeout: BROWSER_TIMEOUT,
        }
    }
}

/// Prazo efetivo do fluxo de login. Antes do navegador abrir, o login tem
/// `login_timeout` (180s) desde o start. Depois do awaiting (browser aberto),
/// o usuário pode demorar no OAuth (2º e-mail, senha, MFA) — o prazo passa a
/// ser `browser_timeout` (10 min) a partir da emissão do awaiting. A ponte
/// NUNCA mata o CLI no redirect do browser (evidência D: ERR_CONNECTION_REFUSED).
fn deadline_expired(
    awaiting_emitted: bool,
    login_started: Instant,
    awaiting_emitted_at: Option<Instant>,
    browser_timeout: Duration,
    login_timeout: Duration,
    now: Instant,
) -> bool {
    let deadline = if awaiting_emitted {
        awaiting_emitted_at.unwrap_or(login_started) + browser_timeout
    } else {
        login_started + login_timeout
    };
    now > deadline
}

/// Fotografia autoritativa, sanitizada e estável das contas conectadas do
/// provedor segundo o próprio CLI. O `account_id` é o identificador opaco que
/// o protocolo `provider-accounts list` já expõe; tokens e subject IDs nunca
/// atravessam este seam.
fn connected_provider_account_ids(
    provider: &str,
    accounts: &[ProviderAccountSummary],
) -> BTreeSet<String> {
    accounts
        .iter()
        .filter(|account| {
            account.provider == provider
                && account.connection_state == "connected"
                && !account.account_id.trim().is_empty()
        })
        .map(|account| account.account_id.clone())
        .collect()
}

fn sanitized_provider_confirmation_error_code(code: &str) -> &str {
    match code {
        "provider_auth_required"
        | "verboo_auth_required"
        | "provider_account_not_found"
        | "provider_usage_timeout"
        | "provider_usage_unavailable"
        | "provider_command_unknown"
        | "provider_argument_required"
        | "provider_protocol_error"
        | "provider_cli_unavailable" => code,
        _ => "provider_protocol_error",
    }
}

fn emit_provider_confirmation_error(
    emit: &Arc<dyn Fn(ProviderLoginEvent) + Send + Sync>,
    provider: &str,
    code: &str,
) {
    eprintln!(
        "[verboo:provider-login] provider={} state={:?} message={:?} confirmation_code={}",
        provider,
        ProviderLoginState::Error,
        Some(PROVIDER_LOGIN_CONFIRMATION_FAILED),
        sanitized_provider_confirmation_error_code(code),
    );
    emit(ProviderLoginEvent {
        provider: provider.to_string(),
        state: ProviderLoginState::Error,
        message: Some(PROVIDER_LOGIN_CONFIRMATION_FAILED.to_string()),
    });
}

/// Loga e emite o evento de login no stderr — o erro do usuário (D) era
/// invisível: o toast do renderer some e nenhum log registrava o motivo.
/// Os 4 erros + connected são os que decidem o desfecho do fluxo.
fn emit_logged(emit: &Arc<dyn Fn(ProviderLoginEvent) + Send + Sync>, event: ProviderLoginEvent) {
    eprintln!(
        "[verboo:provider-login] provider={} state={:?} message={:?}",
        event.provider, event.state, event.message
    );
    emit(event);
}

/// Serviço de login por PTY. Um único login ativo por vez.
pub struct ProviderLoginService {
    inner: Arc<Mutex<Option<ActiveLogin>>>,
    emit: Arc<dyn Fn(ProviderLoginEvent) + Send + Sync>,
    /// cwd NEUTRO e fora de file provider para o CLI interativo. O CLI ao
    /// subir VARRE o cwd procurando projeto — se o cwd for herdado do app
    /// (ex.: ~/Documents em iCloud), a leitura coordenada PENDURA (medido:
    /// 6min40 vs 0,73s) e o prompt nunca aparece (defeito de campo). O
    /// workdir é um diretório próprio vazio sob o app-data, criado na hora.
    workdir: std::path::PathBuf,
}

struct ActiveLogin {
    provider: String,
    pid: u32,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    master: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    stop: Arc<AtomicBool>,
    /// Comandos da tela de risco (confirm/cancel) — a thread de login espera
    /// aqui quando a tela de aceite de risco aparece.
    command_tx: mpsc::Sender<LoginCommand>,
    /// True quando a thread está parada na tela de risco.
    at_risk_notice: Arc<AtomicBool>,
}

/// Comandos da tela de aceite de risco.
#[derive(Debug, Clone, Copy)]
enum LoginCommand {
    /// O usuário confirmou o risco: navega para a opção 1 (o padrão é a 2)
    /// e Enter — segue ao navegador.
    ConfirmRisk,
    /// O usuário cancelou na tela de risco: Enter na opção 2 (cancelar limpo).
    /// Planned but not yet wired — suppress dead-code warning.
    #[allow(dead_code)]
    CancelRisk,
}

impl ProviderLoginService {
    /// `workdir` é o cwd NEUTRO do CLI interativo (app_data/provider-login-
    /// workdir, criado na hora pelo setup) — NUNCA o cwd herdado do app.
    pub fn new(
        emit: impl Fn(ProviderLoginEvent) + Send + Sync + 'static,
        workdir: std::path::PathBuf,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            emit: Arc::new(emit),
            workdir,
        }
    }

    /// Inicia o login interativo do provedor num PTY.
    ///
    /// `has_session` é calculado pelo chamador (Tauri command) a partir do
    /// estado de autenticação do CLI — o próprio CLI exige sessão Verboo
    /// ativa; propagamos o erro claro quando não há.
    pub fn start(
        &self,
        provider: &str,
        has_session: bool,
        reconnect_account_id: Option<String>,
        options: LoginOptions,
    ) -> Result<String, String> {
        let provider = provider.trim().to_string();
        if provider.is_empty() {
            return Err("provider é obrigatório".to_string());
        }
        if !has_session {
            return Err(
                "Não há sessão Verboo ativa. Entre no Verboo pelo app ou pelo CLI antes de conectar um provedor."
                    .to_string(),
            );
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "estado do login corrompido".to_string())?;
        if inner.is_some() {
            return Err(
                "Já existe um login de provedor em andamento. Cancele antes de iniciar outro."
                    .to_string(),
            );
        }

        // Resolve o CLI empacotado (node + cli.mjs) — NUNCA o verboo global.
        let spawn = CliSpawn::new(std::iter::empty::<&str>());
        let (node_path, cli_mjs) = match &spawn.runtime {
            CliRuntime::InstalledNode {
                node_path,
                cli_mjs_path,
                ..
            }
            | CliRuntime::DevelopmentOverride {
                node_path,
                cli_mjs_path,
            } => (node_path.clone(), cli_mjs_path.clone()),
            CliRuntime::Missing => {
                // T-A (2026-08-07): typed error for the no-runtime case,
                // never raw ENOENT. The PTY login requires the bundled
                // CLI; point the user to the API-key alternative.
                return Err(crate::services::cli_spawn::runtime_missing_error());
            }
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Falha ao abrir o PTY: {e}"))?;

        let mut cmd = CommandBuilder::new(&node_path);
        cmd.arg(&cli_mjs);
        cmd.env("TERM", "xterm-256color");
        // FORCE_COLOR=0: a detecção do prompt é mais estável sem cores ANSI.
        cmd.env("FORCE_COLOR", "0");
        for (k, v) in CliSpawn::cli_env_entries() {
            cmd.env(k, v);
        }
        // cwd NEUTRO e fora de file provider: o CLI ao subir VARRE o cwd
        // procurando projeto — herdado do app (Documents/iCloud) a leitura
        // coordenada PENDURA e o prompt nunca aparece (defeito de campo).
        cmd.cwd(&self.workdir);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Falha ao clonar o leitor do PTY: {e}"))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Falha ao iniciar o CLI no PTY: {e}"))?;
        let pid = child
            .process_id()
            .ok_or_else(|| "não foi possível obter o PID do CLI no PTY".to_string())?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let master: Box<dyn portable_pty::MasterPty + Send> = pair.master;
        let writer = master
            .take_writer()
            .map_err(|e| format!("Falha ao obter o writer do PTY: {e}"))?;
        let master_arc = Arc::new(Mutex::new(Some(master)));
        let writer_arc: Arc<Mutex<Option<Box<dyn Write + Send>>>> =
            Arc::new(Mutex::new(Some(writer)));
        let stop = Arc::new(AtomicBool::new(false));

        let id = Uuid::new_v4().to_string();
        // Canal da tela de risco: o confirm/cancel do usuário chega aqui.
        let (command_tx, command_rx) = mpsc::channel::<LoginCommand>();
        let at_risk_notice = Arc::new(AtomicBool::new(false));
        *inner = Some(ActiveLogin {
            provider: provider.clone(),
            pid,
            killer,
            master: master_arc.clone(),
            stop: stop.clone(),
            command_tx,
            at_risk_notice: at_risk_notice.clone(),
        });

        // Reader numa thread: o loop de login nunca bloqueia no read do PTY.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        let _ = tx.send(Vec::new()); // EOF marker (chunk vazio)
                        break;
                    }
                    Ok(n) => {
                        if tx.send(buffer[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Vec::new());
                        break;
                    }
                }
            }
        });

        // Thread de login: prompt-ready → slash → (tela de risco?) → poll.
        let provider_for_thread = provider.clone();
        let reconnect_for_thread = reconnect_account_id;
        let stop_for_thread = stop.clone();
        let master_for_cleanup = master_arc.clone();
        let writer_for_slash = writer_arc.clone();
        let emit = self.emit.clone();
        let inner_for_cleanup = self.inner.clone();
        let at_risk_notice_for_thread = at_risk_notice.clone();
        std::thread::spawn(move || {
            let mut output = String::new();
            let mut prompt_sent = false;
            let mut at_risk = false;
            let mut awaiting_emitted = false;
            let mut awaiting_emitted_at: Option<Instant> = None;
            let mut last_poll = Instant::now();
            let login_started = Instant::now();
            let prompt_deadline = login_started + options.prompt_timeout;
            // O protocolo é opcional em CLIs antigos. Só um capability flag
            // positivo torna este canal autoritativo e permite que falhas dele
            // encerrem o fluxo; capability ausente/indisponível preserva o
            // comportamento cross-platform anterior, guiado pelo blob.
            let cli_confirmation_available = provider_accounts::provider_capabilities()
                .map(|capabilities| capabilities.provider_accounts_v1)
                .unwrap_or(false);
            let mut initial_cli_accounts: Option<BTreeSet<String>> = None;
            let mut cli_confirmation_failures = 0u8;
            // Snapshot do estado de login DO provedor NO MOMENTO DO SLASH
            // (2ª conta: o blob JÁ tem o token da conexão existente). O poll
            // só emite Connected quando ESTE snapshot muda — token key OU
            // registro de contas (`providerAccounts.<provider>`), normalizado
            // sem voláteis de refresh (guarda obrigatória: refresh de fundo
            // não é conta nova). Sem isto, o fluxo de 2ª conta emite
            // Connected prematuro (evidência 2026-08-10) e o teardown mata o
            // CLI no meio do OAuth do usuário → ERR_CONNECTION_REFUSED no
            // callback 1455; E a 2ª conta NÃO-default (registro ganha conta
            // sem a chave token mudar) nunca emite Connected → lista stale
            // até reiniciar.
            let mut initial_login_state: serde_json::Value =
                serde_json::json!({ "token": null, "accounts": null });

            loop {
                let now = Instant::now();
                if stop_for_thread.load(Ordering::SeqCst) {
                    break; // cancelado — sem evento (o cancel é ação do usuário).
                }

                // Tela de risco: a ponte NUNCA aceita risco sozinha — para e
                // espera o confirm/cancel do usuário (o poll não roda aqui).
                if at_risk {
                    match command_rx.try_recv() {
                        Ok(LoginCommand::ConfirmRisk) => {
                            // O padrão do menu é a opção 2 (Cancelar) — navega
                            // para a 1 (seta para cima) e Enter. A seta e o
                            // Enter DEVEM ir SEPARADOS com flush e intervalo
                            // entre eles — o Ink NÃO processa a navegação quando
                            // chegam colados no mesmo write (o Enter cai na
                            // opção PADRÃO, que é a 2 = Cancelar). Prova A/B do
                            // dono no CLI real: colados cancela, separados avança
                            // ao OAuth. Mesma família do \n vs \r: o terminal real
                            // exige o ritmo, não só os bytes.
                            if let Ok(mut w) = writer_for_slash.lock() {
                                if let Some(writer) = w.as_mut() {
                                    let _ = writer.write_all(b"\x1b[A");
                                    let _ = writer.flush();
                                    std::thread::sleep(MENU_NAV_INTERVAL);
                                    let _ = writer.write_all(b"\r");
                                    let _ = writer.flush();
                                }
                            }
                            at_risk = false;
                            at_risk_notice_for_thread.store(false, Ordering::SeqCst);
                            // Limpa o buffer do detector: o texto da tela de
                            // risco não pode re-disparar o risk_notice após o
                            // confirm (o output acumulado ainda o contém).
                            output.clear();
                            // O awaiting_browser vem do drain (a evidência do
                            // URL do navegador), nunca por eliminação.
                        }
                        Ok(LoginCommand::CancelRisk) => {
                            // O cancel mata limpo (killpg) — a escolha da
                            // opção 2 na tela é detalhe dispensável; o que
                            // nunca pode acontecer é a ponte aceitar sozinha.
                            break;
                        }
                        Err(mpsc::TryRecvError::Empty) => {}
                        Err(_) => break,
                    }
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }

                // Poll do estado de autenticação FORA da tela (nunca TUI).
                if prompt_sent && now.duration_since(last_poll) >= POLL_INTERVAL {
                    // Evidência POR PROVEDOR (não o global): o token daquele
                    // provider no blob do keychain. O global logged_in é da
                    // sessão Verboo — espalhá-lo aqui emitiu Connected FALSO
                    // 1s após o slash (o dono logado no Verboo => poll viaja
                    // => killpg mata o CLI aos ~4s => listener do callback
                    // morre => ERR_CONNECTION_REFUSED no redirecionamento).
                    // 5a instância da mancha global — a mesma dos cartões.
                    if let Some(blob) = provider_catalog::read_provider_credentials_blob() {
                        let current_entry = provider_catalog::cli_storage_key(
                            &provider_for_thread,
                        )
                        .and_then(|key| blob.get(key))
                        .cloned();
                        let connected = current_entry
                            .as_ref()
                            .map(|entry| !entry.is_null())
                            .unwrap_or(false);
                        // CHANGE DETECTION (2ª conta, evidência 2026-08-10):
                        // emite Connected SOMENTE quando o SNAPSHOT do provedor
                        // MUDA do capturado no momento do slash — a chave token
                        // OU o registro de contas `providerAccounts.<provider>`
                        // (normalizado sem voláteis de refresh). No fluxo de 2ª
                        // conta o blob JÁ tem o token da conexão existente —
                        // sem isto o poll casa o token PRÉVIO e emite Connected
                        // antes do OAuth do usuário completar, o teardown mata
                        // o PTY, o CLI morre, o listener 1455 morre e o
                        // callback recebe ERR_CONNECTION_REFUSED. E sem o
                        // registro, a 2ª conta NÃO-default (registro ganha
                        // conta, chave token espelhada na default) nunca emite
                        // Connected → lista stale até reiniciar (2026-08-10).
                        // 1º login: snapshot token null → Some é mudança →
                        // Connected continua sendo detectado normalmente.
                        let current_state = provider_catalog::provider_login_state_snapshot(
                            &provider_for_thread,
                            &blob,
                        );
                        if connected && current_state != initial_login_state {
                            emit_logged(&emit, ProviderLoginEvent {
                                provider: provider_for_thread.clone(),
                                state: ProviderLoginState::Connected,
                                message: None,
                            });
                            break;
                        }
                    }
                    // Confirmação AUTORITATIVA pelo protocolo do próprio CLI,
                    // somente quando o capability flag declarou suporte. Se o
                    // blob DPAPI estiver ilegível no Windows, uma conta
                    // conectada que não existia na fotografia pré-login ainda
                    // conclui o fluxo. O caminho do blob permanece acima como
                    // fast path nas plataformas em que ele funciona.
                    if cli_confirmation_available {
                        match provider_accounts::provider_accounts_list() {
                            Ok(accounts) => {
                                cli_confirmation_failures = 0;
                                let current_accounts = connected_provider_account_ids(
                                    &provider_for_thread,
                                    &accounts,
                                );
                                let account_appeared = initial_cli_accounts
                                    .as_ref()
                                    .map(|initial_accounts| {
                                        current_accounts.iter().any(|account_id| {
                                            !initial_accounts.contains(account_id)
                                        })
                                    })
                                    .unwrap_or(false);
                                if account_appeared {
                                    emit_logged(
                                        &emit,
                                        ProviderLoginEvent {
                                            provider: provider_for_thread.clone(),
                                            state: ProviderLoginState::Connected,
                                            message: None,
                                        },
                                    );
                                    break;
                                }
                                if initial_cli_accounts.is_none() {
                                    // A fotografia pré-login falhou, mas uma
                                    // consulta posterior se recuperou. Esta
                                    // primeira resposta válida vira a baseline;
                                    // nunca tratamos contas já existentes como
                                    // sucesso por ausência de fotografia.
                                    initial_cli_accounts = Some(current_accounts);
                                }
                            }
                            Err(code) => {
                                cli_confirmation_failures =
                                    cli_confirmation_failures.saturating_add(1);
                                if cli_confirmation_failures >= PROVIDER_ACCOUNTS_FAILURE_LIMIT {
                                    emit_provider_confirmation_error(
                                        &emit,
                                        &provider_for_thread,
                                        &code,
                                    );
                                    break;
                                }
                            }
                        }
                    }
                    if deadline_expired(
                        awaiting_emitted,
                        login_started,
                        awaiting_emitted_at,
                        options.browser_timeout,
                        options.login_timeout,
                        now,
                    ) {
                        emit_logged(&emit, ProviderLoginEvent {
                            provider: provider_for_thread.clone(),
                            state: ProviderLoginState::Error,
                            message: Some(
                                "Login não concluído dentro do prazo — o navegador foi fechado? Tente novamente."
                                    .to_string(),
                            ),
                        });
                        break;
                    }
                    last_poll = now;
                }

                match rx.try_recv() {
                    Ok(chunk) if chunk.is_empty() => {
                        // EOF do PTY: o CLI saiu sozinho.
                        if !stop_for_thread.load(Ordering::SeqCst) {
                            emit_logged(&emit, ProviderLoginEvent {
                                provider: provider_for_thread.clone(),
                                state: ProviderLoginState::Error,
                                message: Some(if prompt_sent {
                                    "O CLI encerrou antes de concluir o login.".to_string()
                                } else {
                                    "O CLI encerrou antes de apresentar o prompt interativo."
                                        .to_string()
                                }),
                            });
                        }
                        break;
                    }
                    Ok(chunk) => {
                        let raw = String::from_utf8_lossy(&chunk).to_string();
                        if !prompt_sent {
                            output.push_str(&strip_terminal_controls(&raw));
                            if prompt_ready(&output) {
                                prompt_sent = true;
                                // Baseline do change detection: o estado do
                                // provedor ANTES do slash (chave token +
                                // registro de contas, normalizado). O OAuth
                                // do usuário ainda não começou — qualquer
                                // "connected" neste instante é o estado
                                // PRÉVIO (2ª conta).
                                if let Some(snapshot_blob) =
                                    provider_catalog::read_provider_credentials_blob()
                                {
                                    initial_login_state = provider_catalog::
                                        provider_login_state_snapshot(
                                            &provider_for_thread,
                                            &snapshot_blob,
                                        );
                                }
                                // O baseline do protocolo é capturado no MESMO
                                // ponto prompt-ready do blob, ainda antes do
                                // slash. Uma resposta válida vira fotografia;
                                // sem ela, o poll só pode estabelecer baseline,
                                // nunca concluir por comparação com vazio.
                                if cli_confirmation_available {
                                    match provider_accounts::provider_accounts_list() {
                                        Ok(accounts) => {
                                            initial_cli_accounts = Some(
                                                connected_provider_account_ids(
                                                    &provider_for_thread,
                                                    &accounts,
                                                ),
                                            );
                                            cli_confirmation_failures = 0;
                                        }
                                        Err(_) => {
                                            initial_cli_accounts = None;
                                            cli_confirmation_failures = 1;
                                        }
                                    }
                                }
                                if let Ok(mut w) = writer_for_slash.lock() {
                                    if let Some(writer) = w.as_mut() {
                                        // CAUSA RAIZ DO CONECTAR: o TUI em modo raw SÓ SUBMETE com \r
                                        // (CR) — \n (LF) fica parado no buffer. Prova A/B do dono no CLI
                                        // real: com \n o comando nunca submete; com \r o fluxo vai ao OAuth.
                                        let command = reconnect_for_thread
                                            .as_deref()
                                            .filter(|id| !id.trim().is_empty())
                                            .map(|id| format!("/{provider_for_thread} login --reconnect {id}\r"))
                                            .unwrap_or_else(|| format!("/{provider_for_thread} login\r"));
                                        let _ = writer.write_all(command.as_bytes());
                                        let _ = writer.flush();
                                    }
                                }
                                // O awaiting_browser é emitido POR EVIDÊNCIA
                                // (o URL do navegador no drain), nunca por
                                // eliminação — ver o bloco pós-slash abaixo.
                            } else if now > prompt_deadline {
                                emit_logged(&emit, ProviderLoginEvent {
                                    provider: provider_for_thread.clone(),
                                    state: ProviderLoginState::Error,
                                    message: Some(
                                        "O CLI não apresentou o prompt interativo — a ponte não digita no vazio."
                                            .to_string(),
                                    ),
                                });
                                break;
                            }
                        } else if !at_risk {
                            // Pós-slash: (a) a TELA DE ACEITE DE RISCO (o
                            // /claude login — aviso da Anthropic; a ponte
                            // NUNCA aceita sozinha — emite e PARA), (b) o
                            // NAVEGADOR (a evidência: o URL do OAuth ou a
                            // linha "Opening browser" — o awaiting_browser
                            // NUNCA por eliminação). Qualquer outra saída é
                            // apenas observada: a TUI pode mudar entre versões
                            // e não é prova de falha. A credencial, o EOF, o
                            // cancelamento e os timeouts reais são a autoridade.
                            output.push_str(&strip_terminal_controls(&raw));
                            if risk_notice_ready(&output) {
                                at_risk = true;
                                at_risk_notice_for_thread.store(true, Ordering::SeqCst);
                                (emit)(ProviderLoginEvent {
                                    provider: provider_for_thread.clone(),
                                    state: ProviderLoginState::RiskNotice,
                                    message: Some(risk_notice_text(&output)),
                                });
                            } else if !awaiting_emitted && browser_evidence(&output) {
                                awaiting_emitted = true;
                                awaiting_emitted_at = Some(now);
                                last_poll = now;
                                (emit)(ProviderLoginEvent {
                                    provider: provider_for_thread.clone(),
                                    state: ProviderLoginState::AwaitingBrowser,
                                    message: None,
                                });
                            }
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                    Err(_) => break,
                }

                if !prompt_sent && now > prompt_deadline {
                    emit_logged(&emit, ProviderLoginEvent {
                        provider: provider_for_thread.clone(),
                        state: ProviderLoginState::Error,
                        message: Some(
                            "O CLI não apresentou o prompt interativo — a ponte não digita no vazio."
                                .to_string(),
                        ),
                    });
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }

            // Cleanup: mata o process group do PTY inteiro (sem órfãos) e
            // fecha o PTY (o reader thread morre no EOF). O killer guardado
            // no ActiveLogin é dropado quando o estado é limpo abaixo.
            #[cfg(unix)]
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
            if let Ok(mut m) = master_for_cleanup.lock() {
                let _ = m.take();
            }
            if let Ok(mut w) = writer_for_slash.lock() {
                let _ = w.take();
            }
            if let Ok(mut inner) = inner_for_cleanup.lock() {
                if let Some(active) = inner.as_ref() {
                    if active.provider == provider_for_thread && active.pid == pid {
                        *inner = None;
                    }
                }
            }
        });

        Ok(id)
    }

    /// Cancela o login em andamento: mata o process group do PTY inteiro —
    /// sem órfãos.
    /// Confirma o aceite de risco (o usuário leu a tela e decidiu): a ponte
    /// navega para a opção 1 (o padrão do menu é a 2 — Cancelar) e Enter —
    /// o CLI segue ao navegador. A ponte NUNCA aceita risco sozinha.
    pub fn confirm_risk(&self, provider: &str) -> Result<(), String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "estado do login corrompido".to_string())?;
        let Some(active) = inner.as_ref() else {
            return Err("Não há login de provedor em andamento.".to_string());
        };
        if active.provider != provider {
            return Err(format!(
                "O login em andamento é do provedor {}, não {provider}.",
                active.provider
            ));
        }
        if !active.at_risk_notice.load(Ordering::SeqCst) {
            return Err("Não há tela de risco aguardando confirmação.".to_string());
        }
        active
            .command_tx
            .send(LoginCommand::ConfirmRisk)
            .map_err(|_| "A thread de login não está mais ativa.".to_string())
    }

    /// Cancela o login em andamento: mata o process group do PTY inteiro —
    /// sem órfãos. Na tela de risco, escolhe a opção 2 (cancelar limpo)
    /// antes de matar.
    pub fn cancel(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "estado do login corrompido".to_string())?;
        let Some(mut active) = inner.take() else {
            return Err("Não há login de provedor em andamento.".to_string());
        };
        active.stop.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        unsafe {
            libc::killpg(active.pid as i32, libc::SIGKILL);
        }
        // Fallback caso o killpg falhe (ex.: grupo não existe) — nunca deixa
        // o CLI vivo.
        let _ = active.killer.kill();
        if let Ok(mut m) = active.master.lock() {
            let _ = m.take();
        }
        Ok(())
    }
}

/// Normaliza o texto do TUI para o casamento de padrões: strip de ANSI +
/// COLAPSO DE ESPAÇOS. No fluxo bruto do PTY a renderização do TUI come os
/// espaços ("Entendo e aceito o risco" aparece como "Entendoeaceitoorisco" —
/// medido em sondagem) — casar com os rótulos COM espaços falha.
fn normalize_risk_text(output: &str) -> String {
    strip_terminal_controls(output).replace(' ', "")
}

/// Detector da TELA DE ACEITE DE RISCO (o /claude login mostra o aviso da
/// Anthropic sobre OAuth de terceiros — medido no clone verboo-cli:
/// claude.tsx Select com defaultFocusValue="cancel" e as opções "Entendo e
/// aceito o risco" / "Cancelar e continuar com o Verboo").
///
/// ÂNCORA: o padrão do MENU (as opções) + a estrutura 1./2., casado no
/// texto NORMALIZADO (sem ANSI, sem espaços) — o texto do aviso pode mudar
/// e a renderização come espaços; o menu e a estrutura não. Nada de frase
/// inteira hardcoded.
fn risk_notice_ready(output: &str) -> bool {
    let normalized = normalize_risk_text(output);
    normalized.contains("Entendoeaceito")
        && normalized.contains("Cancelar")
        && normalized.contains("1.")
        && normalized.contains("2.")
}

/// Evidência POSITIVA de navegador: o URL do OAuth que o CLI imprime ao
/// abrir, ou a linha "Opening browser". O awaiting_browser NUNCA por
/// eliminação.
///
/// D2: a ancora NAO e qualquer URL — a tela de risco do Claude CONTEM URLs
/// de politica/termos no texto:
///   https://code.claude.com/docs/en/legal-and-compliance
///   https://www.anthropic.com/legal/consumer-terms
/// Esses chegam ANTES do menu 1./2. completo => risk_notice_ready false
/// => o else-if dispara awaiting_browser falso. O dono ve "Aguardando
/// navegador..." e o dialogo nunca aparece. A ancora e o URL do OAuth DE
/// VERDADE: oauth/authorize + redirect_uri (localhost:1455). Os links de
/// politica NAO casam nada disso.
fn browser_evidence(output: &str) -> bool {
    // O TUI corrompe o URL no buffer do PTY (evidência REAL, 2026-08-10:
    // "oauth/authorize" vira "outh/uthorize" — letras comidas na
    // re-renderização — e o URL é quebrado em linhas). As âncoras ESTÁVEIS
    // à corrupção são o redirect_uri (íntegro no buffer real) e o localhost
    // (URL-encoded ou literal, porta efêmera ou fixa 1455). Os links de
    // política/termos não têm nenhuma delas. NAO depende da porta fixa.
    output.contains("redirect_uri")
        || output.contains("localhost%3A")
        || output.contains("localhost:")
        || output.contains("Opening browser")
}

/// Remove os chars de frame do TUI (╭╮╰╯│─) que a renderização deixa no
/// buffer do PTY, preservando quebras e URLs — a tela de risco tem os links
/// de política/termos e o texto reportado precisa continuar fiel (contrato
/// com a Aquarela: renderer recebe texto limpo, sem frames).
fn strip_tui_frames(text: &str) -> String {
    text.chars()
        .filter(|ch| !matches!(ch, '╭' | '╮' | '╰' | '╯' | '│' | '─'))
        .collect()
}

/// Texto da tela de risco reportado no evento (o que a ponte viu — o aviso
/// + os links de política/termos que o CLI exibe). Resumo fiel, não
/// reconstrução: sem ANSI nem frames do TUI, com quebras e URLs intactas.
fn risk_notice_text(output: &str) -> String {
    let cleaned = strip_tui_frames(&strip_terminal_controls(output));
    let trimmed = cleaned.trim();
    // Char-safe: o byte-slice cru PANICS em UTF-8 multibyte (a tela de risco
    // PT-BR tem acentos) — recua até a fronteira de char.
    if trimmed.len() > 2000 {
        let mut end = 2000;
        while end > 0 && !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &trimmed[..end])
    } else {
        trimmed.to_string()
    }
}

/// Detector do prompt interativo do CLI. O prompt REAL do 0.15.2 é o
/// "❯" do TUI (dentro do box — NÃO a última linha: o status/auto-update
/// vêm depois; medido em PTY com cwd neutro: o "❯" aparece em ~1.8s). O
/// detector aceita o "❯" no buffer (o TUI real) OU a última linha com um
/// marcador comum (o shell/fake).
fn prompt_ready(output: &str) -> bool {
    if output.contains('❯') {
        return true;
    }
    match output.lines().rev().find(|l| !l.trim().is_empty()) {
        Some(line) => {
            let trimmed = line.trim_end();
            ["$", "#", "%", ">"].iter().any(|m| trimmed.ends_with(m))
        }
        None => false,
    }
}

impl Default for ProviderLoginService {
    fn default() -> Self {
        Self::new(|_| {}, std::env::temp_dir())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Escreve o CLI falso (node): `auth status` lê um arquivo de estado;
    /// o modo interativo emite o prompt (ou tela inesperada), grava o slash
    /// recebido e spawna um filho (sleep) para a prova de órfão.
    fn write_fake_cli(
        suffix: &str,
        unexpected: bool,
    ) -> (
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let dir = std::env::temp_dir().join(format!(
            "verboo-login-fake-cli-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli.mjs");
        let state_file = dir.join("auth-state.json");
        let received_file = dir.join("received.txt");
        let child_pid_file = dir.join("child.pid");
        let cwd_file = dir.join("cwd.txt");
        let provider_accounts_file = dir.join("provider-accounts.json");
        let provider_accounts_calls_file = dir.join("provider-accounts-calls.txt");
        // O dir pode ser reutilizado (o pid do cargo test se repete no macOS):
        // remove os artefatos de uma execução anterior para o teste nunca ler
        // um child.pid/received.txt velho.
        let _ = std::fs::remove_file(&child_pid_file);
        let _ = std::fs::remove_file(&received_file);
        let _ = std::fs::remove_file(&provider_accounts_calls_file);
        std::fs::write(&provider_accounts_file, r#"{"accounts":[]}"#).unwrap();
        // Blob VAZIO por padrão — isola o poll do keychain real. O dono pode
        // ter um token de codex/claude no keychain; sem isto, o poll emite
        // Connected e quebra testes que esperam Error/timeout/cancel. Testes
        // que precisam de um token chamam set_fake_blob(provider, Some(tok)).
        let blob_file = dir.join("credentials.json");
        std::fs::write(&blob_file, "{}").unwrap();
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_CREDENTIALS_BLOB", &blob_file);
        }
        let script = format!(
            r#"import fs from 'node:fs';
const stateFile = process.env.FAKE_AUTH_STATE;
const receivedFile = process.env.FAKE_RECEIVED;
const childPidFile = process.env.FAKE_CHILD_PID;
const cwdFile = process.env.FAKE_CWD_FILE;
const providerAccountsFile = process.env.FAKE_PROVIDER_ACCOUNTS;
const providerAccountsCallsFile = process.env.FAKE_PROVIDER_ACCOUNTS_CALLS;
const providerAccountsAtPrompt = process.env.FAKE_PROVIDER_ACCOUNTS_AT_PROMPT;
if (process.argv[2] === 'provider-accounts') {{
  const fixture = JSON.parse(fs.readFileSync(providerAccountsFile, 'utf8'));
  const protocolError = fixture.unsupported
    ? {{ code: 'provider_command_unknown', message: 'unknown command provider-accounts' }}
    : fixture.error;
  if (process.argv[3] === 'capabilities') {{
    if (protocolError) {{
      console.log(JSON.stringify({{
        schemaVersion: 1,
        ok: false,
        data: null,
        error: protocolError,
      }}));
      process.exit(1);
    }}
    console.log(JSON.stringify({{
      schemaVersion: 1,
      ok: true,
      data: {{ protocols: fixture.protocols ?? ['provider_accounts_v1'] }},
      error: null,
    }}));
    process.exit(0);
  }}
  const calls = fs.existsSync(providerAccountsCallsFile)
    ? Number(fs.readFileSync(providerAccountsCallsFile, 'utf8')) || 0
    : 0;
  fs.writeFileSync(providerAccountsCallsFile, String(calls + 1));
  if (protocolError) {{
    console.log(JSON.stringify({{
      schemaVersion: 1,
      ok: false,
      data: null,
      error: protocolError,
    }}));
    process.exit(1);
  }}
  console.log(JSON.stringify({{
    schemaVersion: 1,
    ok: true,
    data: {{ accounts: fixture.accounts ?? [] }},
    error: null,
  }}));
  process.exit(0);
}}
if (process.argv[2] === 'auth') {{
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  console.log(JSON.stringify(state));
  process.exit(0);
}}
fs.writeFileSync(cwdFile, process.cwd());
if (process.env.FAKE_UNEXPECTED === '1') {{
  console.log('Tela de primeira execucao sem prompt...');
  setInterval(() => {{}}, 1000);
}} else if (process.env.FAKE_UNKNOWN === '1') {{
  console.log('Verboo Code — primeiro uso\nverboo> ');
  process.stdin.on('data', (d) => {{
    const s = d.toString();
    if (s.includes('/codex login')) {{
      // Uma tela NÃO reconhecida: sem o menu do risco, sem o URL do
      // navegador — o awaiting NUNCA pode ser emitido por eliminação.
      console.log('Alguma tela estranha sem estrutura conhecida...');
    }} else {{
      fs.writeFileSync(receivedFile, d.toString());
    }}
  }});
  setInterval(() => {{}}, 1000);
}} else if (process.env.FAKE_OAUTH_CORRUPTED === '1') {{
  console.log('Verboo Code — primeiro uso\nverboo> ');
  process.stdin.on('data', (d) => {{
    const s = d.toString();
    if (s.includes('/codex login')) {{
      // Fixture REAL do buffer do PTY (CLI 0.15.12, 2026-08-10): o TUI
      // corrompe "oauth/authorize" -> "outh/uthorize" (letras comidas na
      // re-renderização) e quebra o URL em linhas — mas o redirect_uri
      // permanece íntegro. O CLI fica vivo esperando o callback.
      console.log('Preparandoologinnonavegador…');
      console.log('Conclu o lgin noavegador.');
      console.log('http://auth.openai.com/outh/uthorize?response_type=code&client_id=app_EMoamEE\\nZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_acc');
    }} else {{
      fs.writeFileSync(receivedFile, d.toString());
    }}
  }});
  setInterval(() => {{}}, 1000);
}} else if (process.env.FAKE_RISK === '1') {{
  console.log('Verboo Code — primeiro uso\nverboo> ');
  // Raw mode: o Ink real poe o terminal em raw mode (sem line buffering).
  // Sem isto, o PTY line-buffera a seta ate o \n chegar — coalesce os
  // dois writes num so data event, mascarando o defeito do confirm colado.
  if (process.stdin.isTTY) {{ process.stdin.setRawMode(true); }}
  let option1Selected = false;
  process.stdin.on('data', (d) => {{
    const s = d.toString();
    if (s.includes('/claude login')) {{
      // Fixture REAL: a renderização do TUI come os espaços (sondagem).
      // D2: a tela de risco do Claude CONTEM URLs de politica/termos no
      // texto. Esses chegam ANTES do menu 1./2. completo — reproduz o
      // campo onde browser_evidence fraca (contains('https://')) dispara
      // awaiting_browser falso. O menu vem 200ms depois (chunk separado).
      console.log('AvisoimportantesobreologinClaude\nAAnthropicinformaqueoOAuthdeassinaturasClaudeédestinadoaoClaudeCode.\nPolitica:https://code.claude.com/docs/en/legal-and-compliance\nTermos:https://www.anthropic.com/legal/consumer-terms');
      setTimeout(() => {{
        console.log('1.Entendoeaceitoorisco\n2.Cancelarecontinuarcomoverboo');
      }}, 200);
    }} else if (s.includes('\x1b[A') && s.includes('\r')) {{
      // COLADOS no mesmo write — o Ink real NÃO processa a navegacao
      // (o Enter cai na opcao PADRAO = Cancelar). Prova A/B do dono no
      // CLI real: colados cancela, separados avanca ao OAuth. O fake
      // exige o mesmo ritmo — a mutacao 'juntar os dois' fica RED.
      // Raw mode: \r NAO e convertido a \n (ICRNL desligado).
      fs.appendFileSync(receivedFile, s);
      console.log('Claude nao habilitado. O Verboo continua disponivel.');
      console.log('verboo> ');
    }} else if (s.includes('\x1b[A')) {{
      // Seta sozinha — marca a opcao 1 como selecionada.
      fs.appendFileSync(receivedFile, s);
      option1Selected = true;
    }} else if (s.includes('\r')) {{
      // Enter sozinho — se a opcao 1 foi selecionada antes, aceita o
      // risco e segue ao navegador (URL do OAuth com porta efemera).
      // Raw mode: \r NAO e convertido a \n (ICRNL desligado).
      fs.appendFileSync(receivedFile, s);
      if (option1Selected) {{
        console.log('Login Claude nativo\\nPreparando o login no navegador...');
        console.log('Opening browser: https://claude.com/cai/oauth/authorize?response_type=code&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=http%3A%2F%2Flocalhost%3A51866%2Fcallback&scope=openid+profile+email+offline_access');
      }} else {{
        console.log('Claude nao habilitado. O Verboo continua disponivel.');
        console.log('verboo> ');
      }}
    }}
  }});
  setInterval(() => {{}}, 1000);
}} else {{
  if (providerAccountsAtPrompt) {{
    // Give the pre-prompt desktop snapshot a deterministic chance to run.
    // The corrected bridge snapshots only after this prompt is observed.
    await new Promise(resolve => setTimeout(resolve, 1500));
    fs.writeFileSync(providerAccountsFile, providerAccountsAtPrompt);
  }}
  console.log('Verboo Code — primeiro uso\nverboo> ');
  const child = (await import('node:child_process')).spawn('sleep', ['300']);
  fs.writeFileSync(childPidFile, String(child.pid));
  process.stdin.on('data', (d) => {{
    const s = d.toString();
    if (s.includes('/codex login')) {{
      fs.writeFileSync(receivedFile, d.toString());
      // O fluxo normal (codex): o CLI abre o navegador — a evidência.
      console.log('Opening browser: https://auth.verboo.ai/oauth/codex?code=abc');
    }} else {{
      fs.writeFileSync(receivedFile, d.toString());
    }}
  }});
  setInterval(() => {{}}, 1000);
}}
"#
        );
        std::fs::write(&path, script).unwrap();
        std::fs::write(
            &state_file,
            r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#,
        )
        .unwrap();
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("VERBOO_CLI_PATH", &path);
            std::env::set_var("FAKE_AUTH_STATE", &state_file);
            std::env::set_var("FAKE_RECEIVED", &received_file);
            std::env::set_var("FAKE_CHILD_PID", &child_pid_file);
            std::env::set_var("FAKE_CWD_FILE", &cwd_file);
            std::env::set_var("FAKE_PROVIDER_ACCOUNTS", &provider_accounts_file);
            std::env::set_var(
                "FAKE_PROVIDER_ACCOUNTS_CALLS",
                &provider_accounts_calls_file,
            );
            if unexpected {
                std::env::set_var("FAKE_UNEXPECTED", "1");
            } else {
                std::env::remove_var("FAKE_UNEXPECTED");
            }
        }
        (path, state_file, received_file, child_pid_file)
    }

    /// Drop-guard para limpar o ambiente fake mesmo quando o teste PANICA.
    /// Sem isto, um env residual (ex.: FAKE_OAUTH_CORRUPTED) quebra os
    /// testes PTY seguintes do módulo (lição 2026-08-10: residual quebrou
    /// deterministicamente 2 testes seguintes — módulo falha, isolado passa).
    struct FakeCliCleanup;
    impl Drop for FakeCliCleanup {
        fn drop(&mut self) {
            clear_fake_cli();
        }
    }

    fn clear_fake_cli() {
        unsafe {
            std::env::remove_var("VERBOO_CLI_PATH");
            std::env::remove_var("FAKE_AUTH_STATE");
            std::env::remove_var("FAKE_RECEIVED");
            std::env::remove_var("FAKE_CHILD_PID");
            std::env::remove_var("FAKE_CWD_FILE");
            std::env::remove_var("FAKE_PROVIDER_ACCOUNTS");
            std::env::remove_var("FAKE_PROVIDER_ACCOUNTS_CALLS");
            std::env::remove_var("FAKE_PROVIDER_ACCOUNTS_AT_PROMPT");
            std::env::remove_var("FAKE_UNEXPECTED");
            std::env::remove_var("FAKE_RISK");
            std::env::remove_var("FAKE_UNKNOWN");
            std::env::remove_var("FAKE_OAUTH_CORRUPTED");
            std::env::remove_var("FAKE_CREDENTIALS_BLOB");
        }
    }

    #[cfg(unix)]
    fn process_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn set_auth_state(state_file: &std::path::Path, logged_in: bool) {
        let body = format!(
            r#"{{"loggedIn":{logged_in},"authMethod":"oauth","apiProvider":"firstParty"}}"#
        );
        std::fs::write(state_file, body).unwrap();
    }

    /// Escreve um blob de credenciais FAKE (o mesmo shape do keychain real:
    /// `{ codex: {...}, claudeNative: {...}, verbooOauth: {...},
    /// verbooInstallationId: "..." }`) e aponta FAKE_CREDENTIALS_BLOB para
    /// ele. O poll lê deste arquivo em vez do keychain real.
    /// `provider_token` = None → blob vazio (sem provedor conectado);
    /// Some(tok) → blob com a entrada daquele provedor sob a chave de
    /// storage REAL do CLI (cli_storage_key — NÃO o provider id do app).
    fn set_fake_blob(provider: &str, provider_token: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verboo-login-fake-blob-{}-{}",
            std::process::id(),
            provider
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let blob_file = dir.join("credentials.json");
        let blob = match provider_token {
            Some(tok) => {
                let key = provider_catalog::cli_storage_key(provider)
                    .expect("set_fake_blob recebeu provider desconhecido");
                serde_json::json!({
                    key: {
                        "accessToken": tok,
                        "refreshToken": "ref",
                        "accountId": "acct-test",
                    }
                })
            }
            None => serde_json::json!({}),
        };
        std::fs::write(&blob_file, serde_json::to_string(&blob).unwrap()).unwrap();
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_CREDENTIALS_BLOB", &blob_file);
        }
        blob_file
    }

    /// Escreve um blob COMPLETO (chave token + providerAccounts) no arquivo
    /// fake e aponta FAKE_CREDENTIALS_BLOB para ele. Os testes montam o JSON
    /// com o shape REAL do CLI 0.15.12 — a 2ª conta aditiva entra no registro
    /// `providerAccounts.<provider>.accounts` sem mudar a chave token
    /// (espelhada na conta DEFAULT por mirrorDefaultCredential).
    fn set_fake_blob_json(provider: &str, blob: serde_json::Value) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verboo-login-fake-blob-{}-{}",
            std::process::id(),
            provider
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let blob_file = dir.join("credentials.json");
        std::fs::write(&blob_file, serde_json::to_string(&blob).unwrap()).unwrap();
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_CREDENTIALS_BLOB", &blob_file);
        }
        blob_file
    }

    fn set_fake_provider_accounts(accounts: serde_json::Value) {
        let path = std::env::var_os("FAKE_PROVIDER_ACCOUNTS")
            .map(std::path::PathBuf::from)
            .expect("write_fake_cli deve configurar FAKE_PROVIDER_ACCOUNTS");
        let fixture = serde_json::json!({ "accounts": accounts });
        std::fs::write(path, serde_json::to_string(&fixture).unwrap()).unwrap();
    }

    fn set_fake_provider_accounts_error(code: &str, message: &str) {
        let path = std::env::var_os("FAKE_PROVIDER_ACCOUNTS")
            .map(std::path::PathBuf::from)
            .expect("write_fake_cli deve configurar FAKE_PROVIDER_ACCOUNTS");
        let fixture = serde_json::json!({
            "error": {
                "code": code,
                "message": message,
            }
        });
        std::fs::write(path, serde_json::to_string(&fixture).unwrap()).unwrap();
    }

    fn set_fake_provider_accounts_unsupported() {
        let path = std::env::var_os("FAKE_PROVIDER_ACCOUNTS")
            .map(std::path::PathBuf::from)
            .expect("write_fake_cli deve configurar FAKE_PROVIDER_ACCOUNTS");
        std::fs::write(path, r#"{"unsupported":true}"#).unwrap();
    }

    fn set_fake_provider_accounts_at_prompt(accounts: serde_json::Value) {
        let fixture = serde_json::json!({ "accounts": accounts });
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var(
                "FAKE_PROVIDER_ACCOUNTS_AT_PROMPT",
                serde_json::to_string(&fixture).unwrap(),
            );
        }
    }

    fn fake_provider_accounts_call_count() -> u32 {
        let path = std::env::var_os("FAKE_PROVIDER_ACCOUNTS_CALLS")
            .map(std::path::PathBuf::from)
            .expect("write_fake_cli deve configurar FAKE_PROVIDER_ACCOUNTS_CALLS");
        std::fs::read_to_string(path)
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0)
    }

    fn wait_until(deadline: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    type LoginEvents = Arc<Mutex<Vec<ProviderLoginEvent>>>;

    fn start_test_login(
        provider: &str,
        browser_timeout: Duration,
    ) -> (ProviderLoginService, LoginEvents) {
        let events: LoginEvents = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );
        service
            .start(
                provider,
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout,
                },
            )
            .expect("start deve abrir o PTY");
        (service, events)
    }

    fn wait_for_login_event(
        events: &LoginEvents,
        deadline: Duration,
        predicate: impl Fn(&ProviderLoginState) -> bool,
    ) -> bool {
        wait_until(deadline, || {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|event| predicate(&event.state))
        })
    }

    fn fake_connected_account(provider: &str, account_id: &str) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "provider": provider,
            "accountId": account_id,
            "displayLabel": "Conta de teste",
            "isDefault": true,
            "connectionState": "connected"
        })
    }

    #[test]
    fn event_shape_matches_the_mosaico_contract() {
        // Canal confirmado: "provider-login:event" (lib.rs). Payload
        // combinado: { provider, state, message? } com state em snake_case.
        let event = ProviderLoginEvent {
            provider: "codex".to_string(),
            state: ProviderLoginState::AwaitingBrowser,
            message: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["provider"], "codex");
        assert_eq!(
            json["state"], "awaiting_browser",
            "o state deve ser snake_case (contrato do Mosaico)"
        );
        assert!(
            !json.as_object().unwrap().contains_key("message"),
            "message ausente quando None (skip_serializing_if)"
        );

        let error_event = ProviderLoginEvent {
            provider: "claude".to_string(),
            state: ProviderLoginState::Error,
            message: Some("falhou".to_string()),
        };
        let error_json = serde_json::to_value(&error_event).unwrap();
        assert_eq!(error_json["state"], "error");
        assert_eq!(error_json["message"], "falhou");
        assert_eq!(
            serde_json::to_value(&ProviderLoginState::Connected).unwrap(),
            "connected"
        );
    }

    #[test]
    fn auth_status_returns_one_entry_per_supported_provider() {
        // CASO DO VÍDEO (estado real da máquina do dono): sessão Verboo
        // ativa, NENHUM provedor conectado — o blob de credenciais do CLI
        // não tem entrada para codex/claude → TODAS connected=false. O
        // loggedIn global da sessão Verboo NUNCA pode manchar o provedor.
        let statuses = provider_auth_status_from_blob(&serde_json::json!({}));
        assert_eq!(
            statuses.len(),
            SUPPORTED_PROVIDERS.len(),
            "uma entrada POR PROVEDOR que a ponte suporta"
        );
        for entry in &statuses {
            assert!(
                SUPPORTED_PROVIDERS.contains(&entry.provider.as_str()),
                "provedor fora do universo da ponte: {}",
                entry.provider
            );
            assert!(
                !entry.connected,
                "nenhum provedor conectado → connected=false (o global da sessão Verboo não mancha): {:?}",
                entry
            );
            assert!(entry.account.is_none(), "sem conta → account ausente");
        }
        assert_eq!(statuses[0].provider, "codex");
        assert_eq!(statuses[1].provider, "claude");
    }

    #[test]
    fn auth_status_uses_per_provider_evidence() {
        // Fixture CAPTURADA do blob real do keychain (4 chaves reais,
        // valores redigidos). claudeNative presente (dict não-nulo) →
        // claude conectado. claude AUSENTE — o app NÃO usa "claude" como
        // chave, usa cli_storage_key("claude") = "claudeNative". codex
        // ausente → false. verbooOauth/verbooInstallationId = globais da
        // sessão Verboo, NÃO mancham o connected por provedor.
        let blob = serde_json::json!({
            "codex": null,
            "claudeNative": {
                "accessToken": "tok",
                "refreshToken": "ref",
                "accountId": "acct-42",
                "email": "dono@example.com",
                "expiresAt": "2026-12-31T23:59:59Z",
                "lastRefreshAt": "2026-08-07T12:00:00Z",
                "organizationId": "org-1",
                "riskAcceptance": "accepted",
                "scopes": ["openid", "profile", "email", "offline_access"]
            },
            "verbooOauth": {
                "accessToken": "verboo-tok",
                "expiresAt": "2026-12-31T23:59:59Z",
                "rateLimitTier": "pro",
                "refreshToken": "verboo-ref",
                "scopes": ["openid", "profile", "email", "offline_access"],
                "subscriptionType": "pro"
            },
            "verbooInstallationId": "inst-abc-123"
        });
        let statuses = provider_auth_status_from_blob(&blob);
        let codex = statuses.iter().find(|e| e.provider == "codex").unwrap();
        let claude = statuses.iter().find(|e| e.provider == "claude").unwrap();
        assert!(!codex.connected, "codex null no blob → false");
        assert!(codex.account.is_none());
        assert!(
            claude.connected,
            "claudeNative presente (dict não-nulo) → claude true"
        );
        assert_eq!(
            claude.account.as_deref(),
            Some("acct-42"),
            "account vem do blob do provedor (claudeNative)"
        );
    }

    #[test]
    fn spawn_uses_neutral_workdir_never_documents() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state, _received, _child) = write_fake_cli("cwd", false);
        // Workdir NEUTRO e fora de file provider (o app-data/provider-login-
        // workdir na produção; aqui um dir temp próprio).
        let workdir =
            std::env::temp_dir().join(format!("verboo-login-workdir-{}", std::process::id()));
        std::fs::create_dir_all(&workdir).unwrap();
        let cwd_file = std::env::temp_dir()
            .join(format!("verboo-login-fake-cli-{}-cwd", std::process::id()))
            .join("cwd.txt");
        let _ = std::fs::remove_file(&cwd_file);
        let service = ProviderLoginService::new(|_| {}, workdir.clone());
        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(5),
                    login_timeout: Duration::from_secs(10),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");
        assert!(
            wait_until(Duration::from_secs(10), || cwd_file.exists()),
            "o CLI falso deve registrar o cwd usado"
        );
        let used_cwd = std::fs::read_to_string(&cwd_file).unwrap_or_default();
        // Node can report a symlink-resolved path on macOS or an 8.3 short
        // path on Windows. Canonicalize both representations before comparing.
        let canonical = workdir.canonicalize().unwrap_or(workdir.clone());
        let used_canonical = std::path::PathBuf::from(used_cwd.trim())
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(used_cwd.trim()));
        assert_eq!(
            used_canonical,
            canonical,
            "o CLI interativo deve rodar no cwd NEUTRO da ponte — nunca o herdado do app"
        );
        let lower = used_cwd.to_lowercase();
        assert!(
            !lower.contains("documents") && !lower.contains("desktop") && !lower.contains("icloud"),
            "o cwd da ponte NUNCA pode cair sob Documents/Desktop/iCloud (file provider pendura a varredura do CLI): {used_cwd}"
        );
        service.cancel().ok();
        clear_fake_cli();
    }

    #[test]
    fn prompt_ready_recognizes_the_real_cli_prompt() {
        // O prompt REAL do CLI 0.15.2 é o "❯" do TUI (dentro do box — NÃO a
        // última linha: o status vem depois). Medido em PTY com cwd neutro:
        // o "❯" aparece em ~1.8s. O detector precisa reconhecê-lo.
        let real_tui_output = "\u{1b}[?2004h\u{1b}[?1004h\u{1b}[?25l\u{1b}]0;✳ Verboo Code\u{7}\u{1b}[?2026h\r\n\r\n\u{1b}[2C0%\u{1b}[1C░░░░░░░░░░░░░░░░\u{1b}[1C0/1.0m\r\n╭──────────────────────────────────────────────────────────────────────────────╮\r\n│\u{1b}[1C❯ \u{1b}[75C│\r\n╰──────────────────────────────────────────────────────────────────────────────╯\r\n\u{1b}[2C?\u{1b}[1Cfor\u{1b}[1Cshortcuts";
        assert!(
            prompt_ready(real_tui_output),
            "o detector deve reconhecer o prompt real do CLI (o ❯ do TUI)"
        );
        // O fake do harness usa "verboo> " (a última linha com >).
        assert!(prompt_ready("Verboo Code — primeiro uso\nverboo> "));
        assert!(!prompt_ready("Tela de primeira execucao sem prompt..."));
    }

    #[test]
    fn risk_notice_text_strips_tui_frames_and_keeps_urls() {
        // Chunk REAL capturado do PTY (CLI 0.15.12, /claude login, 2026-08-10)
        // — frames do TUI (╭╮╰╯│─), ANSI e as URLs de política/termos da tela
        // de risco. O texto reportado precisa sair LIMPO (contrato com a
        // Aquarela: renderer recebe texto limpo) mas fiel: sem frames, com as
        // URLs e as quebras.
        let raw_chunk = "[1C0\u{1b}[1C/\u{1b}[1C1.0m\n\n╭──────────────────────────────────────────────────────────────────────────────╮\n\n│\u{1b}[1C❯\u{a0}Describe\u{1b}[1Ca\u{1b}[1Ctask,\u{1b}[1Cbug,\u{1b}[1Cor\u{1b}[1Cidea…\u{1b}[45C│\n\n╰──────────────────────────────────────────────────────────────────────────────╯\n\n\u{1b}[2C?\u{1b}[1Cfor\u{1b}[1Cshortcuts\u{1b}[46C◉\u{1b}[1Cmax\u{1b}[1C·\u{1b}[1C/effort\n\n\u{1b}[4C\u{1b}[3A\u{1b}[?2026l\u{1b}[>0q\u{1b}[c\u{1b}[?2026h\u{1b}[4D\u{1b}[3B\n\u{1b}[32C\u{1b}[5AVerboo ultra/glm-5.2 ·\u{1b}[1Ccontext 0% ·\u{1b}[1C838\n\n\u{1b}[4C\u{1b}[3A\u{1b}[?2026l\u{1b}[?2026h\u{1b}[4D\u{1b}[3B\n\u{1b}[4C\u{1b}[3A/claude login   \u{1b}[1C    \u{1b}[1C  \u{1b}[1C     \n\n\u{1b}[17C\u{1b}[3A\u{1b}[?2026l\u{1b}]0;⠂ Verboo Code\u{7}\u{1b}[?2026h\u{1b}[17D\u{1b}[3B\n\u{1b}[5A❯\u{1b}[1C/claude\u{1b}[1Clogin\u{1b}[17C      \u{1b}[1C             \u{1b}[1C \u{1b}[1C       \u{1b}[1C  \u{1b}[1C \u{1b}[1C   \u{1b}[1C \u{1b}[1C    \n\u{1b}[1B                                                                                \n\u{1b}[1B────────────────────────────────────────────────────────────────────────────────\n\u{1b}[1B  Aviso importante sobre o login Claude                                         \n\u{1b}[2C\u{1b}[1B \u{1b}[1C   \u{1b}[1C         \u{1b}[46C \u{1b}[1C   \u{1b}[1C \u{1b}[1C       \n\n\u{1b}[2CA\u{1b}[1CAnthropic\u{1b}[1Cinforma\u{1b}[1Cque\u{1b}[1Co\u{1b}[1COAuth\u{1b}[1Cde\u{1b}[1Cassinaturas\u{1b}[1CClaude\u{1b}[1Cé\u{1b}[1Cdestinado\u{1b}[1Cao\u{1b}[1CClaude\n\n\u{1b}[2CCode\u{1b}[1Ce\u{1b}[1Ca\u{1b}[1Coutros\u{1b}[1Caplicativos\u{1b}[1Cnativos.\u{1b}[1CEla\u{1b}[1Cnão\u{1b}[1Cpermite\u{1b}[1Cque\u{1b}[1Cterceiros\u{1b}[1Cofereçam\n\n\u{1b}[2Clogin\u{1b}[1CClaude.ai\u{1b}[1Cnem\u{1b}[1Croteiem\u{1b}[1Csolicitações\u{1b}[1Cusando\u{1b}[1Ccredenciais\u{1b}[1CFree,\u{1b}[1CPro\u{1b}[1Cou\n\n\u{1b}[2CMax.\n\n\n\u{1b}[2CO\u{1b}[1CVerboo\u{1b}[1CCode\u{1b}[1Cnão\u{1b}[1Cé\u{1b}[1Cafiliado\u{1b}[1Cnem\u{1b}[1Cendossado\u{1b}[1Cpela\u{1b}[1CAnthropic.\u{1b}[1CEste\u{1b}[1Cuso\u{1b}[1Cpode\n\n\u{1b}[2Cdeixar\u{1b}[1Cde\u{1b}[1Cfuncionar\u{1b}[1Csem\u{1b}[1Caviso\u{1b}[1Ce\u{1b}[1Cpode\u{1b}[1Cresultar\u{1b}[1Cem\u{1b}[1Climitação\u{1b}[1Cou\u{1b}[1Csuspensão\u{1b}[1Cda\n\n\u{1b}[2Cconta.\u{1b}[1CPrompts,\u{1b}[1Ccódigo\u{1b}[1Ce\u{1b}[1Cresultados\u{1b}[1Cde\u{1b}[1Cferramentas\u{1b}[1Cserão\u{1b}[1Cenviados\n\n\u{1b}[2Cdiretamente\u{1b}[1Cà\u{1b}[1CAnthropic.\n\n\n\u{1b}[2CO\u{1b}[1Caceite\u{1b}[1Cregistra\u{1b}[1Capenas\u{1b}[1Csua\u{1b}[1Cciência\u{1b}[1Ce\u{1b}[1Cnão\u{1b}[1Cconcede\u{1b}[1Cpermissão\u{1b}[1Cda\u{1b}[1CAnthropic.\n\n\n\u{1b}[2CPolítica:\u{1b}[1Chttps://code.claude.com/docs/en/legal-and-compliance\n\n\n\u{1b}[2CTermos:\u{1b}[1Chttps://www.anthropic.com/legal/consumer-terms\n\n\n\u{1b}[4C1.\u{1b}[1CEntendo\u{1b}[1Ce\u{1b}[1Caceito\u{1b}[1Co\u{1b}[1Crisco\n\n\u{1b}[2C❯\u{1b}[1C2.\u{1b}[1CCancelar\u{1b}[1Ce\u{1b}[1Ccontinuar\u{1b}[1Ccom\u{1b}[1Co\u{1b}[1CVerboo\n\n\n\u{1b}[2CEnter\u{1b}[1Cto\u{1b}[1Cconfirm\u{1b}[1C·\u{1b}[1CEsc\u{1b}[1Cto\u{1b}[1Ccancel\n\n\u{1b}[2C\u{1b}[3A\u{1b}[?2026l\u{1b}]0;✳ Verboo Code\u{7}\u{1b}[?2026h\u{1b}[2D\u{1b}[3B\n\u{1b}[2C\u{1b}[1APress\u{1b}[1CCtrl-C again\u{1b}[1Cto exit      \n\n\u{1b}[2C\u{1b}[3A\u{1b}[?2026l\u{1b}[?2026h\u{1b}[2D\u{1b}[3B\n\u{1b}[2C\u{1b}[1AEnter\u{1b}[1Cto confirm ·\u{1b}[1CEsc to cancel\n\n\u{1b}[2C\u{1b}[3A\u{1b}[?2026l";

        let notice = risk_notice_text(raw_chunk);
        for frame in ['╭', '╮', '╰', '╯', '│', '─'] {
            assert!(
                !notice.contains(frame),
                "o char de frame TUI {frame} deve sair do texto reportado"
            );
        }
        assert!(notice.contains("https://www.anthropic.com/legal/consumer-terms"));
        assert!(notice.contains("https://code.claude.com/docs/en/legal-and-compliance"));
        assert!(
            notice.contains("Entendoeaceitoorisco") || notice.contains("Entendo e aceito o risco"),
            "o menu de risco deve sobreviver ao sanitize"
        );
        assert!(notice.contains('\n'), "quebras preservadas no texto reportado");
    }

    #[test]
    fn login_deadline_extends_while_browser_is_open() {
        // Evidência D (2026-08-10): o usuário demorou no OAuth da 2ª conta
        // (segundo e-mail, senha) e o CLI foi morto no redirect do browser —
        // ERR_CONNECTION_REFUSED em localhost:1455. Causa: o login_deadline
        // de 180s é FIXO desde o start e o cleanup mata o PTY (killpg) em
        // todo break. Na fase de browser o prazo é BROWSER_TIMEOUT, não o de
        // login — o usuário não pode ser morto no redirect do browser.
        let started = Instant::now();
        let awaiting_at = started + Duration::from_secs(60);
        // 5 min após o start, browser aberto há 4 min → NÃO expira
        // (browser_timeout de 10 min).
        let now = started + Duration::from_secs(300);
        assert!(
            !deadline_expired(
                true,
                started,
                Some(awaiting_at),
                Duration::from_secs(600),
                Duration::from_secs(180),
                now
            ),
            "com o browser aberto o prazo é o do browser (10 min), não os 180s do login"
        );
        // Sem browser: 300s > 180s → expira (prazo honesto do login).
        assert!(deadline_expired(
            false,
            started,
            None,
            Duration::from_secs(600),
            Duration::from_secs(180),
            now
        ));
        // Com browser, 11 min > 10 min → expira (prazo honesto, não pendura).
        let now2 = started + Duration::from_secs(661);
        assert!(deadline_expired(
            true,
            started,
            Some(awaiting_at),
            Duration::from_secs(600),
            Duration::from_secs(180),
            now2
        ));
    }

    #[test]
    fn risk_screen_emits_risk_notice_and_bridge_waits() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state, _received, _child) = write_fake_cli("risk", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_RISK", "1");
        }
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "claude",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(15),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::RiskNotice))
            }),
            "a tela de risco deve emitir o evento risk_notice (a ponte nunca aceita sozinha)"
        );
        let risk = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| matches!(e.state, ProviderLoginState::RiskNotice))
            .unwrap()
            .clone();
        assert!(matches!(risk.state, ProviderLoginState::RiskNotice));
        assert_eq!(risk.provider, "claude");
        let text = risk.message.as_deref().unwrap_or("");
        // O texto REAL do fluxo bruto é COLAPSADO (a renderização do TUI come
        // os espaços — a fixture) — o detector normaliza antes de casar.
        assert!(
            text.contains("Entendoeaceito") && text.contains("Cancelar"),
            "o texto da tela (resumo fiel) deve ser reportado: {text}"
        );
        // A ponte PARA na tela: nenhum connected antes do confirm.
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::Connected)),
            "a ponte não pode seguir sozinha pela tela de risco"
        );
        // D2: a tela de risco do Claude CONTEM URLs de politica/termos no
        // texto. A ancora fraca (contains('https://')) dispara
        // awaiting_browser falso — o dono ve "Aguardando navegador..." e o
        // dialogo nunca aparece. Com a ancora no URL do OAuth DE VERDADE
        // (oauth/authorize + redirect_uri), os links de politica NAO casam.
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser)),
            "a tela de risco NAO emite awaiting_browser — os URLs de politica \
             nao sao o OAuth de verdade"
        );
        service.cancel().ok();
        clear_fake_cli();
    }

    /// D2: browser_evidence ancora no URL do OAuth DE VERDADE (oauth/authorize
    /// + redirect_uri/localhost), nao qualquer URL. Os links de
    /// politica/termos da tela de risco do Claude NAO casam. NAO depende da
    /// porta 1455 — o claude SORTEIA porta efemera. Robusto contra quebra de
    /// linha no terminal. Mutação voltar para contains('https://') => RED.
    #[test]
    fn browser_evidence_anchors_on_oauth_url_not_policy_links() {
        // Tela de risco do Claude: URLs de politica/termos no texto.
        let risk_screen_with_policy_urls = "Aviso importante sobre o login Claude\n\
             Politica: https://code.claude.com/docs/en/legal-and-compliance\n\
             Termos: https://www.anthropic.com/legal/consumer-terms\n\
             1. Entendo e aceito o risco\n\
             2. Cancelar e continuar com o verboo";
        assert!(
            !browser_evidence(risk_screen_with_policy_urls),
            "os URLs de politica/termos NAO sao o OAuth — nao emite awaiting_browser"
        );

        // URL real do OAuth do codex (porta 1455).
        let codex_oauth_url =
            "Opening browser: https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access";
        assert!(
            browser_evidence(codex_oauth_url),
            "o URL real do OAuth do codex DEVE casar (oauth/authorize + redirect_uri)"
        );

        // URL real do OAuth do Claude (porta EFEMERA 51866 — nao 1455).
        let claude_oauth_url =
            "Opening browser: https://claude.com/cai/oauth/authorize?response_type=code&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&redirect_uri=http%3A%2F%2Flocalhost%3A51866%2Fcallback&scope=openid+profile+email+offline_access";
        assert!(
            browser_evidence(claude_oauth_url),
            "o URL real do OAuth do Claude DEVE casar (porta efemera, nao 1455)"
        );

        // URL QUEBRADO em varias linhas (o terminal quebra o URL largo).
        // A ancora NAO pode depender de um trecho que a quebra parta ao meio.
        // oauth/authorize e redirect_uri ficam intactos (nao sao partidos).
        let broken_claude_url =
            "Opening browser: https://claude.com/cai/oauth/authorize?response_type=code&client_id=9d1c250a-e61b-44d9-88\ned-5944d1962f5e&redirect_uri=http%3A%2F%2Flocalhost%3A51866%2Fcallback&scope=openid+profile+email+offline_access";
        assert!(
            browser_evidence(broken_claude_url),
            "o URL quebrado em linhas ainda casam (oauth/authorize + redirect_uri intactos)"
        );

        // Sem URL algum, sem "Opening browser" — sem evidencia.
        assert!(
            !browser_evidence("1. Entendo e aceito o risco\n2. Cancelar"),
            "sem URL nem Opening browser — sem evidencia"
        );
    }

    #[test]
    fn confirm_risk_navigates_to_option_1_and_enters() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, state_file, received_file, _child) = write_fake_cli("confirm", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_RISK", "1");
        }
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "claude",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::RiskNotice))
            }),
            "a tela de risco deve aparecer"
        );

        service
            .confirm_risk("claude")
            .expect("o confirm deve resolver");
        // Espera a seta E o Enter chegarem (separados por MENU_NAV_INTERVAL).
        // O arquivo existe assim que a seta chega; o \r chega 0.3s depois.
        assert!(
            wait_until(Duration::from_secs(10), || {
                std::fs::read_to_string(&received_file)
                    .map(|s| s.contains('\r'))
                    .unwrap_or(false)
            }),
            "o CLI deve receber a seta E o Enter (separados por 0.3s)"
        );
        // O padrão do menu é a opção 2 (Cancelar) — o confirm navega para a 1
        // (seta para cima) e Enter. Raw mode: \r NAO e convertido a \n (ICRNL
        // desligado pelo Ink real). A seta e o Enter chegam SEPARADOS (com
        // intervalo) — colados o Ink nao processa a navegacao.
        let received = std::fs::read_to_string(&received_file).unwrap_or_default();
        assert_eq!(
            received, "\x1b[A\r",
            "o confirm deve navegar para a opção 1 (seta up) e Enter (raw mode, \\r)"
        );
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser))
            }),
            "após o confirm, o fluxo segue ao navegador (awaiting_browser)"
        );
        // O poll lê o blob POR PROVEDOR (não o global logged_in). O token
        // daquele provider no blob = evidência de conexão.
        set_fake_blob("claude", Some("claude-oauth-tok"));
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Connected))
            }),
            "o poll detecta o login após o confirm (blob do provedor)"
        );
        service.cancel().ok();
        clear_fake_cli();
    }

    #[test]
    fn cancel_on_risk_screen_kills_cleanly_never_accepts_alone() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state, received_file, _child) = write_fake_cli("riskcancel", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_RISK", "1");
        }
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "claude",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::RiskNotice))
            }),
            "a tela de risco deve aparecer"
        );

        // O cancel mata limpo (killpg) — a escolha da opção 2 é detalhe
        // dispensável; o INEGOCIÁVEL é a ponte nunca aceitar o risco sozinha.
        service.cancel().expect("o cancel deve resolver");
        assert!(
            !std::path::Path::new(&received_file).exists(),
            "o cancel na tela de risco NÃO pode enviar aceite — mata limpo sem interagir com o menu"
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::Connected)),
            "o cancel nunca pode seguir ao navegador (a ponte não aceita risco sozinha)"
        );
        clear_fake_cli();
    }

    #[test]
    fn risk_notice_detector_anchors_on_the_menu_not_the_full_text() {
        // A tela real (medida no clone verboo-cli): o Select com as opções
        // "Entendo e aceito o risco" / "Cancelar e continuar com o Verboo".
        // A âncora é o padrão do MENU + palavras estáveis — o texto do aviso
        // pode mudar, o menu não.
        let screen = "Aviso importante sobre o login Claude\nA Anthropic informa que o OAuth de assinaturas Claude é destinado ao Claude Code.\n1. Entendo e aceito o risco\n2. Cancelar e continuar com o Verboo";
        assert!(risk_notice_ready(screen), "o menu 1/2 deve ser reconhecido");
        // O texto do aviso pode mudar — a âncora (o menu) continua.
        let changed_text = "Aviso atualizado em 2027\n1. Entendo e aceito o risco\n2. Cancelar e continuar com o Verboo";
        assert!(
            risk_notice_ready(changed_text),
            "a âncora é o menu, não o texto"
        );
        // Sem o menu (ex.: o prompt normal) → não é a tela de risco.
        assert!(!risk_notice_ready("Verboo Code — primeiro uso\nverboo> "));
        assert!(!risk_notice_ready(""));
    }

    #[test]
    fn risk_notice_text_truncates_char_safe() {
        // A tela de risco PT-BR tem acentos e pode passar de 2000 bytes — o
        // byte-slice cru PANICS em UTF-8 multibyte (padrão QA-reprovado).
        // O byte 2000 cai no MEIO de um char multibyte ("ç" começa no byte
        // 1999) — sem o walk-back char-safe, isto panics.
        let long = format!("{}çe", "a".repeat(1999));
        let text = risk_notice_text(&long);
        // 2000 bytes do texto + o "…" (3 bytes UTF-8).
        assert!(
            text.len() <= 2003,
            "o texto deve ser truncado char-safe: {}",
            text.len()
        );
        assert!(text.ends_with('…'));
        // O truncate nunca pode dividir um char multibyte: o texto é sempre
        // uma String válida (o byte-slice cru panics em UTF-8) e o corte
        // original recua até a fronteira de char.
        let _ = text.chars().count();
    }

    #[test]
    fn unknown_post_login_screen_waits_for_delayed_credentials() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) = write_fake_cli("unknown", false);
        set_fake_blob("codex", None);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_UNKNOWN", "1");
        }
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        // A CLI 0.15.14 pode redesenhar a TUI sem preservar as âncoras que a
        // ponte conhece. Isso não prova falha: o navegador/callback OAuth
        // pode continuar ativo. Aguarda além do antigo prazo pós-slash de
        // 10s e só então publica a credencial, simulando um login válido e
        // lento numa tela nova.
        std::thread::sleep(Duration::from_secs(12));
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::Error)),
            "uma tela nova/lenta não pode encerrar um OAuth ainda válido"
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser)),
            "o awaiting_browser NUNCA é emitido por eliminação — só com evidência de navegador"
        );

        set_fake_blob("codex", Some("tok-after-unknown-screen"));
        assert!(
            wait_until(Duration::from_secs(5), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Connected))
            }),
            "a ponte deve concluir quando a credencial do provedor aparecer"
        );
    }

    #[test]
    fn browser_evidence_recognizes_corrupted_oauth_url_with_redirect_uri() {
        // Fixture REAL capturada do PTY (CLI 0.15.12, /codex login,
        // 2026-08-10): o TUI corrompe "oauth/authorize" -> "outh/uthorize"
        // no buffer (letras comidas na re-renderização) e quebra o URL em
        // linhas — mas o redirect_uri permanece íntegro. Sem o fix, o
        // browser_evidence (âncora oauth/authorize) não casava. O
        // redirect_uri precisa continuar sendo a evidência positiva usada
        // para informar ao renderer que o navegador abriu.
        let raw = "Conclu o lgin noavegador.\nhttp://auth.openai.com/outh/uthorize?response_type=code&client_id=app_EMoamEE\nZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_acc";
        assert!(
            browser_evidence(raw),
            "o redirect_uri íntegro é evidência de OAuth — o URL corrompido NÃO pode escapar"
        );
    }

    #[cfg(unix)]
    #[test]
    fn corrupted_oauth_url_emits_awaiting_browser_without_error() {
        // Caso REAL (vídeo 11:52): o URL do OAuth sai corrompido no buffer
        // ("outh/uthorize") mas com redirect_uri íntegro. O awaiting deve ser
        // emitido apenas por essa evidência positiva, sem erro espúrio.
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state, _received, _child) = write_fake_cli("oauth_corrupted", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_OAUTH_CORRUPTED", "1");
        }
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(12), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser))
            }),
            "o URL corrompido com redirect_uri deve emitir awaiting_browser (evidência de OAuth)"
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::Error)),
            "a evidência de OAuth não pode produzir erro no fluxo"
        );
        service.cancel().ok();
        clear_fake_cli();
    }

    #[test]
    fn start_requires_an_active_verboo_session() {
        let service = ProviderLoginService::default();
        let error = service
            .start("codex", false, None, LoginOptions::default())
            .unwrap_err();
        assert!(
            error.contains("sessão Verboo ativa"),
            "gate de sessão deve dar erro claro: {error}"
        );
    }

    #[test]
    fn login_success_prompt_then_slash_then_connected() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, state_file, received_file, _child_pid) = write_fake_cli("success", false);
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        // O slash só pode ser enviado DEPOIS do prompt ficar pronto.
        assert!(
            wait_until(Duration::from_secs(10), || {
                std::path::Path::new(&received_file).exists()
            }),
            "o CLI deve ter recebido o slash"
        );
        let received = std::fs::read_to_string(&received_file).unwrap_or_default();
        assert!(
            matches!(
                received.as_str(),
                "/codex login\n" | "/codex login\r" | "/codex login\r\n"
            ),
            "o terminal deve entregar somente o slash e um submit, recebido: {received:?}"
        );

        // Sucesso detectado FORA da tela: poll do blob POR PROVEDOR (nunca
        // o global logged_in, nunca TUI). O token daquele provider no blob
        // = evidência de conexão.
        set_fake_blob("codex", Some("codex-oauth-tok"));
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Connected))
            }),
            "o poll deve detectar o login (blob do provedor) e emitir connected"
        );

        let snap: Vec<(String, String)> = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| (e.provider.clone(), format!("{:?}", e.state)))
            .collect();
        assert_eq!(
            snap,
            vec![
                ("codex".to_string(), "AwaitingBrowser".to_string()),
                ("codex".to_string(), "Connected".to_string()),
            ],
            "a sequência de eventos deve ser awaiting_browser → connected"
        );
        clear_fake_cli();
    }

    #[test]
    fn unreadable_blob_with_new_cli_account_emits_connected() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) =
            write_fake_cli("cli-account-confirms-login", false);
        let blob_file = set_fake_blob("codex", None);
        std::fs::write(&blob_file, "{blob-dpapi-ilegivel").unwrap();
        set_fake_provider_accounts(serde_json::json!([]));
        let (_service, events) = start_test_login("codex", Duration::from_secs(15));

        assert!(
            wait_for_login_event(&events, Duration::from_secs(10), |state| matches!(
                state,
                ProviderLoginState::AwaitingBrowser
            )),
            "o navegador deve abrir antes da confirmação"
        );

        set_fake_provider_accounts(serde_json::json!([fake_connected_account(
            "codex",
            "codex-account-new"
        )]));

        assert!(
            wait_for_login_event(&events, Duration::from_secs(5), |state| matches!(
                state,
                ProviderLoginState::Connected
            )),
            "blob ilegível não pode esconder uma conta nova confirmada por provider-accounts list"
        );
    }

    #[test]
    fn no_new_account_in_blob_or_cli_keeps_waiting() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) =
            write_fake_cli("no-new-account-keeps-waiting", false);
        set_fake_blob("codex", Some("token-ja-existente"));
        set_fake_provider_accounts(serde_json::json!([fake_connected_account(
            "codex",
            "codex-account-existing"
        )]));
        let (service, events) = start_test_login("codex", Duration::from_secs(30));

        assert!(
            wait_for_login_event(&events, Duration::from_secs(10), |state| matches!(
                state,
                ProviderLoginState::AwaitingBrowser
            )),
            "o navegador deve abrir antes da confirmação"
        );
        assert!(
            wait_until(Duration::from_secs(5), || {
                fake_provider_accounts_call_count() >= 2
            }),
            "a confirmação deve consultar o protocolo depois da fotografia pré-login"
        );

        let terminal_event = events.lock().unwrap().iter().any(|event| {
            matches!(
                event.state,
                ProviderLoginState::Connected | ProviderLoginState::Error
            )
        });
        assert!(
            !terminal_event,
            "sem conta nova no blob nem no protocolo, o fluxo deve continuar aguardando"
        );

        service.cancel().expect("o login ainda deve estar em andamento");
    }

    #[test]
    fn repeated_cli_confirmation_failures_emit_sanitized_error_before_timeout() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) =
            write_fake_cli("cli-confirmation-fails", false);
        let blob_file = set_fake_blob("codex", None);
        std::fs::write(&blob_file, "{blob-dpapi-ilegivel").unwrap();
        set_fake_provider_accounts(serde_json::json!([]));
        let (_service, events) = start_test_login("codex", Duration::from_secs(30));

        assert!(
            wait_for_login_event(&events, Duration::from_secs(10), |state| matches!(
                state,
                ProviderLoginState::AwaitingBrowser
            )),
            "o navegador deve abrir antes da falha de confirmação"
        );
        let calls_before_failure = fake_provider_accounts_call_count();
        set_fake_provider_accounts_error(
            "token=segredo-que-nao-pode-vazar",
            "Bearer sk-super-secreto",
        );

        assert!(
            wait_for_login_event(&events, Duration::from_secs(8), |state| matches!(
                state,
                ProviderLoginState::Error
            )),
            "três falhas consecutivas da confirmação devem encerrar antes do timeout de browser"
        );
        assert!(
            fake_provider_accounts_call_count() >= calls_before_failure + 3,
            "uma falha transitória não deve encerrar o login"
        );

        let terminal = events.lock().unwrap().last().cloned().unwrap();
        assert!(matches!(terminal.state, ProviderLoginState::Error));
        assert_eq!(
            terminal.message.as_deref(),
            Some("provider_login_confirmation_failed")
        );
        let serialized = serde_json::to_string(&terminal).unwrap();
        assert!(!serialized.contains("provider_protocol_error"));
        assert!(!serialized.contains("segredo-que-nao-pode-vazar"));
        assert!(!serialized.contains("sk-super-secreto"));
        assert!(!serialized.contains("Bearer"));
    }

    #[test]
    fn unsupported_provider_accounts_protocol_keeps_blob_login_alive() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) =
            write_fake_cli("unsupported-provider-accounts", false);
        set_fake_blob("codex", None);
        set_fake_provider_accounts_unsupported();
        let (_service, events) = start_test_login("codex", Duration::from_secs(30));

        assert!(
            wait_for_login_event(&events, Duration::from_secs(10), |state| matches!(
                state,
                ProviderLoginState::AwaitingBrowser
            )),
            "o navegador deve abrir mesmo quando o CLI é anterior ao protocolo"
        );

        let terminated_early = wait_until(Duration::from_secs(4), || {
            events.lock().unwrap().iter().any(|event| {
                matches!(
                    event.state,
                    ProviderLoginState::Connected | ProviderLoginState::Error
                )
            })
        });
        assert!(
            !terminated_early,
            "provider_command_unknown deve desativar só o canal opcional, não matar o login"
        );

        set_fake_blob("codex", Some("token-confirmado-pelo-blob"));
        assert!(
            wait_for_login_event(&events, Duration::from_secs(5), |state| matches!(
                state,
                ProviderLoginState::Connected
            )),
            "sem provider-accounts, o fast path do blob ainda deve concluir o login"
        );
    }

    #[test]
    fn account_visible_at_prompt_is_baseline_not_new_login() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) =
            write_fake_cli("provider-account-baseline-at-prompt", false);
        let blob_file = set_fake_blob("codex", None);
        std::fs::write(&blob_file, "{blob-dpapi-ilegivel").unwrap();
        set_fake_provider_accounts(serde_json::json!([]));
        set_fake_provider_accounts_at_prompt(serde_json::json!([fake_connected_account(
            "codex",
            "codex-account-existing",
        )]));
        let (service, events) = start_test_login("codex", Duration::from_secs(30));

        assert!(
            wait_for_login_event(&events, Duration::from_secs(10), |state| matches!(
                state,
                ProviderLoginState::AwaitingBrowser | ProviderLoginState::Connected
            )),
            "o fake deve avançar o fluxo depois de publicar a conta junto do prompt"
        );
        assert!(
            wait_until(Duration::from_secs(5), || {
                fake_provider_accounts_call_count() >= 2
            }),
            "o poll deve consultar o protocolo depois do baseline em prompt-ready"
        );

        let terminal_event = events.lock().unwrap().iter().any(|event| {
            matches!(
                event.state,
                ProviderLoginState::Connected | ProviderLoginState::Error
            )
        });
        assert!(
            !terminal_event,
            "conta já visível em prompt-ready pertence ao baseline e não é login novo"
        );

        service.cancel().expect("o login deve continuar aguardando");
    }

    /// 5a instância da mancha global: o poll NÃO usa state.logged_in (global
    /// Verboo) — usa o blob POR PROVEDOR. Reproduz o campo: global=true +
    /// blob SEM o provider => NAO emite Connected (o CLI segue vivo); com
    /// token do provider aparecendo no blob => Connected. A mutação voltar
    /// ao logged_in global => RED na primeira asserção (o global=true emite
    /// Connected FALSO 1s após o slash — o toast que o dono reclamou, e o
    /// killpg mata o CLI aos ~4s => ERR_CONNECTION_REFUSED no callback).
    #[test]
    fn poll_uses_per_provider_blob_not_global_logged_in() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, state_file, received_file, _child_pid) = write_fake_cli("poll-blob", false);
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(60),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        // Espera o prompt + slash.
        assert!(
            wait_until(Duration::from_secs(10), || {
                std::path::Path::new(&received_file).exists()
            }),
            "o CLI deve receber o slash"
        );

        // CAMPO REPRODUZIDO: global logged_in=true (dono logado no Verboo) +
        // blob SEM o token do codex. O poll NAO emite Connected.
        set_auth_state(&state_file, true);
        set_fake_blob("codex", None);
        std::thread::sleep(Duration::from_secs(3));
        let connected_while_no_token = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e.state, ProviderLoginState::Connected));
        assert!(
            !connected_while_no_token,
            "global logged_in=true NAO emite Connected — o poll usa o blob POR \
             PROVEDOR. Com a mutação (state.logged_in), isto fica RED: o global \
             emite Connected FALSO 1s após o slash (o toast que o dono reclamou) \
             e o killpg mata o CLI aos ~4s => ERR_CONNECTION_REFUSED no callback."
        );

        // Token do provedor aparece no blob — OAuth completou.
        set_fake_blob("codex", Some("codex-oauth-tok"));
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Connected))
            }),
            "o poll detecta o token do provedor no blob e emite Connected"
        );

        service.cancel().ok();
        clear_fake_cli();
    }

    /// CAMPO DO DEFEITO (CLI 0.15.12, 2026-08-10): o usuário TEM uma conta
    /// codex conectada e clica "Adicionar conta". O blob JÁ tem o token
    /// codex da conexão existente; o poll atual casa esse token PRÉVIO e
    /// emite Connected ANTES do OAuth do usuário completar — o teardown
    /// mata o PTY, o CLI morre, o listener 1455 morre, e o callback do
    /// OAuth do usuário recebe ERR_CONNECTION_REFUSED. Evidência real:
    /// bridge emitiu `[verboo:provider-login] provider=codex state=Connected
    /// message=None` segundos após o clique, SEM awaiting_browser.
    ///
    /// FIX: snapshot do token do provedor no momento do slash; o poll só
    /// emite Connected quando o token MUDA do snapshot. O token PRÉVIO
    /// (conta existente) NÃO dispara — só o token NOVO do OAuth completado.
    /// Usar apenas a presença do URL como gate é insuficiente: ele é
    /// observado ~100ms depois do prompt, mas o token PRÉVIO continua no
    /// blob até o OAuth completar — o gate apenas adiantaria o Connected em
    /// ~1s e o teardown ainda mataria o callback.
    #[test]
    fn second_account_with_existing_token_does_not_emit_connected_prematurely() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) = write_fake_cli("second-account", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_OAUTH_CORRUPTED", "1");
        }
        // BLOB com token codex PRÉVIO (conta existente). O fake CLI NÃO
        // atualiza o blob — o OAuth do usuário não completou. Sem o fix,
        // o poll casa este token PRÉVIO e emite Connected prematuro.
        set_fake_blob("codex", Some("old-codex-tok"));

        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(3),
                },
            )
            .expect("start deve abrir o PTY");

        // Hoje (sem fix): o poll dispara Connected ANTES do URL ser
        // processado (o break encerra o chunk handler) → awaiting_browser
        // nunca é emitido → esta asserção fica RED.
        // Pós-fix: o poll não casa (token unchanged) → URL é processado
        // → awaiting_browser emitido.
        assert!(
            wait_until(Duration::from_secs(15), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser))
            }),
            "awaiting_browser deve ser emitido — o URL do OAuth DEVE ser \
             observado (evidência real 2026-08-10: o URL é impresso pelo CLI)"
        );

        // Espera o browser_timeout (3s) expirar — bridge emite Error.
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Error))
            }),
            "o timeout honesto deve disparar — o OAuth não completou"
        );

        // NENHUM Connected pode ter sido emitido — o token do blob NÃO
        // mudou do snapshot no momento do slash. Sem o fix, o poll casa o
        // token PRÉVIO e emite Connected prematuro → teardown do PTY →
        // CLI morto → listener 1455 morto → callback do OAuth do usuário
        // recebe ERR_CONNECTION_REFUSED.
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::Connected)),
            "o poll NÃO pode emitir Connected com o token PRÉVIO do blob — \
             aguardar MUDANÇA de token (OAuth completou). Sem o fix, o dono \
             recebe ERR_CONNECTION_REFUSED no callback 1455."
        );

        service.cancel().ok();
        clear_fake_cli();
    }

    /// Direção negativa do `second_account_with_existing_token_does_not_emit_connected_prematurely`:
    /// 1º login (sem conta prévia) DEVE continuar detectando Connected. O
    /// snapshot no momento do slash é None (blob vazio); quando o OAuth
    /// completa e o token do provedor aparece no blob, o poll vê a MUDANÇA
    /// (None → Some) e emite Connected normalmente.
    #[test]
    fn first_login_emits_connected_when_token_appears_after_oauth_evidence() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) = write_fake_cli("first-login", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_OAUTH_CORRUPTED", "1");
        }
        // BLOB VAZIO no start — 1º login (sem conta prévia). O fake CLI
        // imprime o URL do OAuth; depois do URL, o teste escreve o token
        // novo no blob (simula callback do OAuth completado).
        set_fake_blob("codex", None);

        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        // Espera o URL do OAuth ser observado (awaiting_browser) — isto
        // confirma que o slash foi enviado E o URL processado.
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser))
            }),
            "awaiting_browser deve ser emitido quando o URL é observado"
        );

        // OAuth completou: callback escreve token NOVO no blob.
        set_fake_blob("codex", Some("new-codex-tok"));

        // O poll DEVE detectar a MUDANÇA (None → Some) e emitir Connected.
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Connected))
            }),
            "1º login (sem conta prévia) DEVE emitir Connected quando o token \
             aparece no blob após o OAuth — snapshot None → Some é mudança"
        );

        // Sequência esperada: awaiting_browser → connected.
        let snap: Vec<String> = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| format!("{:?}", e.state))
            .collect();
        let awaiting_idx = snap.iter().position(|s| s == "AwaitingBrowser");
        let connected_idx = snap.iter().position(|s| s == "Connected");
        assert!(
            awaiting_idx.is_some() && connected_idx.is_some()
                && awaiting_idx < connected_idx,
            "a sequência deve ser awaiting_browser → connected: {snap:?}"
        );

        service.cancel().ok();
        clear_fake_cli();
    }

    /// Campo reportado pelo dono (2026-08-10): a 2ª conta Codex conecta com
    /// sucesso mas SÓ aparece na lista após reiniciar. Evidência do keychain
    /// real + cli.mjs 0.15.12: o login ADITIVO escreve a conta nova no
    /// REGISTRO `providerAccounts.codex.accounts`, mas a chave `codex`
    /// (token) fica espelhada na conta DEFAULT (`mirrorDefaultCredential`)
    /// — a chave token NÃO muda. O poll só observava a chave token → nunca
    /// emitia Connected → o reload do renderer nunca rodava.
    ///
    /// RED (hoje): registro ganha a conta B sem mudar a chave token → NÃO
    /// emite Connected. GREEN (pós-fix): o snapshot cobre token + registro
    /// normalizado → emite Connected.
    #[test]
    fn second_account_gaining_registry_account_emits_connected_without_token_change() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) = write_fake_cli("second-account-registry", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_OAUTH_CORRUPTED", "1");
        }
        // Conta A (default) — chave token + registro consistentes.
        let blob_conta_a = serde_json::json!({
            "codex": {
                "accessToken": "tok-a", "refreshToken": "ref-a",
                "accountId": "subj-a", "idToken": "id-a", "lastRefreshAt": 1000,
            },
            "providerAccounts": {
                "schemaVersion": 1,
                "codex": {
                    "defaultAccountId": "local-a",
                    "accounts": {
                        "local-a": {
                            "localAccountId": "local-a",
                            "providerSubjectId": "subj-a",
                            "displayLabel": "Codex 1",
                            "connectionState": "connected",
                            "credential": { "accessToken": "tok-a", "lastRefreshAt": 1000 },
                        }
                    }
                }
            }
        });
        set_fake_blob_json("codex", blob_conta_a.clone());

        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(20),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(15), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser))
            }),
            "awaiting_browser deve ser emitido — o URL do OAuth deve ser observado"
        );

        // OAuth completa: o registro ganha a conta B; a chave token NÃO muda
        // (continua espelhada na conta DEFAULT A — mirrorDefaultCredential).
        let blob_conta_a_e_b = serde_json::json!({
            "codex": {
                "accessToken": "tok-a", "refreshToken": "ref-a",
                "accountId": "subj-a", "idToken": "id-a", "lastRefreshAt": 1000,
            },
            "providerAccounts": {
                "schemaVersion": 1,
                "codex": {
                    "defaultAccountId": "local-a",
                    "accounts": {
                        "local-a": {
                            "localAccountId": "local-a",
                            "providerSubjectId": "subj-a",
                            "displayLabel": "Codex 1",
                            "connectionState": "connected",
                            "credential": { "accessToken": "tok-a", "lastRefreshAt": 1000 },
                        },
                        "local-b": {
                            "localAccountId": "local-b",
                            "providerSubjectId": "subj-b",
                            "displayLabel": "Codex 2",
                            "connectionState": "connected",
                            "credential": { "accessToken": "tok-b", "lastRefreshAt": 2000 },
                        }
                    }
                }
            }
        });
        set_fake_blob_json("codex", blob_conta_a_e_b);

        // RED hoje: o poll só observa a chave `codex` (inalterada) → NUNCA
        // emite Connected → timeout. GREEN pós-fix: o registro normalizado
        // ganhou a conta B → Connected.
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Connected))
            }),
            "o registro ganhou a conta B (chave token inalterada) — Connected DEVE \
             emitir. Sem o fix, o poll só observa a chave `codex` (espelhada na \
             conta default) e nunca emite → lista stale até reiniciar (campo 2026-08-10)"
        );

        service.cancel().ok();
        clear_fake_cli();
    }

    /// GUARDA OBRIGATÓRIA (GO do Maestro): um refresh de fundo que SÓ muda os
    /// voláteis (`lastRefreshAt`/`lastValidatedAt`/`lastRefreshFailureAt`) no
    /// token key E no registro NÃO pode disparar Connected. O snapshot é
    /// normalizado SEM esses campos — refresh de fundo não é conta nova.
    ///
    /// RED hoje: o poll compara a chave token INTEIRA → lastRefreshAt novo →
    /// Connected prematuro. GREEN pós-fix: snapshot normalizado → nada muda →
    /// Error honesto no browser_timeout, NENHUM Connected.
    #[test]
    fn background_refresh_changing_only_volatile_fields_does_not_emit_connected() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cleanup = FakeCliCleanup;
        let (_cli, _state, _received, _child) = write_fake_cli("background-refresh", false);
        // SAFETY: env global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("FAKE_OAUTH_CORRUPTED", "1");
        }
        // Conta A conectada (token + registro). Chave token IGUAL em ambos os
        // estados — só os voláteis mudam no "refresh".
        let blob_antes = serde_json::json!({
            "codex": {
                "accessToken": "tok-a", "refreshToken": "ref-a",
                "accountId": "subj-a", "idToken": "id-a",
                "lastRefreshAt": 1000, "lastRefreshFailureAt": 0,
            },
            "providerAccounts": {
                "schemaVersion": 1,
                "codex": {
                    "defaultAccountId": "local-a",
                    "accounts": {
                        "local-a": {
                            "localAccountId": "local-a",
                            "providerSubjectId": "subj-a",
                            "displayLabel": "Codex 1",
                            "connectionState": "connected",
                            "credential": {
                                "accessToken": "tok-a",
                                "lastRefreshAt": 1000, "lastRefreshFailureAt": 0,
                            },
                            "lastValidatedAt": "2026-08-09T00:00:00.000Z",
                        }
                    }
                }
            }
        });
        let blob_depois = serde_json::json!({
            "codex": {
                "accessToken": "tok-a", "refreshToken": "ref-a",
                "accountId": "subj-a", "idToken": "id-a",
                "lastRefreshAt": 9999, "lastRefreshFailureAt": 0,
            },
            "providerAccounts": {
                "schemaVersion": 1,
                "codex": {
                    "defaultAccountId": "local-a",
                    "accounts": {
                        "local-a": {
                            "localAccountId": "local-a",
                            "providerSubjectId": "subj-a",
                            "displayLabel": "Codex 1",
                            "connectionState": "connected",
                            "credential": {
                                "accessToken": "tok-a",
                                "lastRefreshAt": 9999, "lastRefreshFailureAt": 0,
                            },
                            "lastValidatedAt": "2026-08-10T00:00:00.000Z",
                        }
                    }
                }
            }
        });
        set_fake_blob_json("codex", blob_antes);

        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(30),
                    browser_timeout: Duration::from_secs(5),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(15), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::AwaitingBrowser))
            }),
            "awaiting_browser deve ser emitido — o URL do OAuth deve ser observado"
        );

        // Refresh de fundo: SÓ os voláteis mudam (token key e registro).
        set_fake_blob_json("codex", blob_depois);

        // O bridge deve esperar o browser_timeout e emitir Error honesto —
        // NENHUM Connected (a normalização descarta os voláteis).
        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Error))
            }),
            "o timeout honesto deve disparar — o OAuth não completou"
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e.state, ProviderLoginState::Connected)),
            "refresh de fundo (só lastRefreshAt/lastValidatedAt) NÃO pode emitir \
             Connected — a guarda de normalização é obrigatória"
        );

        service.cancel().ok();
        clear_fake_cli();
    }

    #[test]
    fn login_timeout_returns_honest_error() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state_file, _received_file, _child_pid) = write_fake_cli("timeout", false);
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "claude",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(5),
                    login_timeout: Duration::from_secs(3),
                    browser_timeout: Duration::from_secs(3),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Error))
            }),
            "o timeout honesto deve emitir error (o usuário fechou o navegador?)"
        );
        let last = events.lock().unwrap().last().unwrap().clone();
        assert!(matches!(last.state, ProviderLoginState::Error));
        assert!(
            last.message.as_deref().unwrap_or("").contains("prazo"),
            "a mensagem de timeout deve ser honesta: {:?}",
            last.message
        );
        clear_fake_cli();
    }

    #[cfg(unix)]
    #[test]
    fn cancel_kills_the_whole_process_group_no_orphans() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state_file, _received_file, child_pid_file) = write_fake_cli("cancel", false);
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(10),
                    login_timeout: Duration::from_secs(60),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(10), || std::path::Path::new(
                &child_pid_file
            )
            .exists()),
            "o CLI falso deve ter spawnado o filho"
        );
        let child_pid: i32 = std::fs::read_to_string(&child_pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(
            process_alive(child_pid),
            "o filho deve estar vivo antes do cancel"
        );

        service.cancel().expect("cancel deve resolver");

        assert!(
            // Deadline folgado: sob a carga paralela da suíte completa, a
            // morte do grupo pode demorar mais que 5s.
            wait_until(Duration::from_secs(15), || !process_alive(child_pid)),
            "o cancel deve matar o process group INTEIRO — o filho (sleep) não pode ficar órfão"
        );
        // O cancel é ação do usuário: nenhum evento connected/error extra.
        assert!(
            !events.lock().unwrap().iter().any(|e| matches!(
                e.state,
                ProviderLoginState::Connected | ProviderLoginState::Error
            )),
            "o cancel não deve emitir connected/error"
        );
        clear_fake_cli();
    }

    #[test]
    fn unexpected_screen_never_gets_a_slash() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (_cli, _state_file, received_file, _child_pid) = write_fake_cli("unexpected", true);
        let events: Arc<Mutex<Vec<ProviderLoginEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_for_service = events.clone();
        let service = ProviderLoginService::new(
            move |event| {
                events_for_service.lock().unwrap().push(event);
            },
            std::env::temp_dir(),
        );

        let _id = service
            .start(
                "codex",
                true,
                None,
                LoginOptions {
                    prompt_timeout: Duration::from_secs(2),
                    login_timeout: Duration::from_secs(10),
                    browser_timeout: Duration::from_secs(60),
                },
            )
            .expect("start deve abrir o PTY");

        assert!(
            wait_until(Duration::from_secs(10), || {
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| matches!(e.state, ProviderLoginState::Error))
            }),
            "tela inesperada (sem prompt) deve virar erro — a ponte não digita no vazio"
        );
        assert!(
            !std::path::Path::new(&received_file).exists(),
            "nenhum slash pode ser enviado sem o prompt pronto"
        );
        let last = events.lock().unwrap().last().unwrap().clone();
        // O CASO DO VÍDEO: o erro EXATO que o dono viu.
        assert_eq!(
            last.message.as_deref(),
            Some("O CLI não apresentou o prompt interativo — a ponte não digita no vazio."),
            "o erro exibido ao dono deve ser exatamente este"
        );
        clear_fake_cli();
    }

    /// CAUSA RAIZ DO CONECTAR: o TUI em modo raw SÓ SUBMETE com \r (CR).
    /// \n (LF) fica parado no buffer — prova A/B do dono no CLI real.
    /// ICRNL no PTY converte \r→\n antes do child ler, então a asserção
    /// behavioral (received == "/codex login\n") passa nos dois casos e
    /// NÃO distingue a mutação. Esta asserção lê o FONTE e crava \r. A
    /// mutação \r→\n fica VERMELHA para sempre.
    #[test]
    fn slash_uses_carriage_return_not_line_feed() {
        let source = include_str!("provider_login_pty.rs");
        // Construir as needles em runtime: o literal completo NAO aparece
        // neste proprio teste (self-match). O write real contem
        // {provider_for_thread} login\r").as_bytes() como literal no source.
        let prefix = "{provider_for_thread} login";
        let cr_needle = format!("{}\\r\").as_bytes()", prefix);
        let lf_needle = format!("{}\\n\").as_bytes()", prefix);
        assert!(
            source.contains(&cr_needle),
            "o slash DEVE usar \\r (CR) — o TUI raw so submete com CR. \
             Prova A/B do dono no CLI real: \\n fica parado, \\r vai ao OAuth."
        );
        assert!(
            !source.contains(&lf_needle),
            "o slash NAO deve usar \\n (LF) — o TUI raw nao submete com LF."
        );
    }
}
