use serde::{Deserialize, Serialize};

pub type BrowserTabId = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSnapshot {
    pub id: BrowserTabId,
    pub label: String,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
    pub generation: u64,
    pub recoverable_error: Option<String>,
    /// F4-EVICT (2026-08-02): a aba foi DESPEJADA — o webview foi
    /// destruído (para liberar o processo WebContent) mas a ENTRADA da
    /// aba (id, label, url, title) sobreviveu no session model. O
    /// renderer mostra a entrada despejada; reativar recria o webview e
    /// navega para a URL guardada. Sem esta flag o renderer não saberia
    /// distinguir "aba viva" de "aba despejada" — e mostraria uma aba
    /// que não responde a evaluate (silêncio = o pior desfecho).
    pub evicted: bool,
}

impl BrowserTabSnapshot {
    pub fn blank(id: BrowserTabId, label: String) -> Self {
        Self {
            id,
            label,
            url: "about:blank".into(),
            title: String::new(),
            can_go_back: false,
            can_go_forward: false,
            loading: false,
            generation: 0,
            recoverable_error: None,
            evicted: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionSnapshot {
    pub tabs: Vec<BrowserTabSnapshot>,
    pub active_tab_id: Option<BrowserTabId>,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    DuplicateTab(BrowserTabId),
    UnknownTab(BrowserTabId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseTabTransition {
    pub closed: BrowserTabId,
    pub next_active: Option<BrowserTabId>,
    pub session_empty: bool,
}

#[derive(Debug, Default)]
pub struct BrowserSessionModel {
    tabs: Vec<BrowserTabSnapshot>,
    active_tab_id: Option<BrowserTabId>,
}

impl BrowserSessionModel {
    pub fn insert_and_activate(&mut self, tab: BrowserTabSnapshot) -> Result<(), SessionError> {
        if self.tabs.iter().any(|current| current.id == tab.id) {
            return Err(SessionError::DuplicateTab(tab.id));
        }
        self.active_tab_id = Some(tab.id.clone());
        self.tabs.push(tab);
        Ok(())
    }

    pub fn activate(&mut self, id: &str) -> Result<(), SessionError> {
        if !self.tabs.iter().any(|tab| tab.id == id) {
            return Err(SessionError::UnknownTab(id.into()));
        }
        self.active_tab_id = Some(id.into());
        Ok(())
    }

    pub fn close(&mut self, id: &str) -> Result<CloseTabTransition, SessionError> {
        let index = self.tabs.iter().position(|tab| tab.id == id)
            .ok_or_else(|| SessionError::UnknownTab(id.into()))?;
        let was_active = self.active_tab_id.as_deref() == Some(id);
        self.tabs.remove(index);
        if was_active {
            self.active_tab_id = self.tabs.get(index)
                .or_else(|| index.checked_sub(1).and_then(|left| self.tabs.get(left)))
                .map(|tab| tab.id.clone());
        }
        Ok(CloseTabTransition {
            closed: id.into(),
            next_active: self.active_tab_id.clone(),
            session_empty: self.tabs.is_empty(),
        })
    }

    pub fn begin_navigation(&mut self, id: &str, url: String) -> Result<u64, SessionError> {
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id)
            .ok_or_else(|| SessionError::UnknownTab(id.into()))?;
        tab.generation = tab.generation.saturating_add(1);
        tab.url = url;
        tab.loading = true;
        tab.recoverable_error = None;
        Ok(tab.generation)
    }

    pub fn is_current_generation(&self, id: &str, generation: u64) -> bool {
        self.tabs.iter().any(|tab| tab.id == id && tab.generation == generation)
    }

    pub fn current_generation(&self, id: &str) -> Option<u64> {
        self.tabs.iter().find(|tab| tab.id == id).map(|tab| tab.generation)
    }

    pub fn active_id(&self) -> Option<&str> {
        self.active_tab_id.as_deref()
    }

    /// F4-EVICT (2026-08-02): marca a aba como despejada (webview
    /// destruído, entrada preservada). Retorna a URL guardada para o
    /// reativador navegar de volta. A URL é o estado que sobrevive ao
    /// despejo — o renderer a exibe na entrada despejada.
    pub fn mark_evicted(&mut self, id: &str, evicted: bool) -> Result<Option<String>, SessionError> {
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id)
            .ok_or_else(|| SessionError::UnknownTab(id.into()))?;
        let url = tab.url.clone();
        tab.evicted = evicted;
        if evicted {
            tab.loading = false;
        }
        Ok(Some(url))
    }

    pub fn tab_mut(&mut self, id: &str) -> Result<&mut BrowserTabSnapshot, SessionError> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
            .ok_or_else(|| SessionError::UnknownTab(id.into()))
    }

    pub fn snapshot(&self, visible: bool) -> BrowserSessionSnapshot {
        BrowserSessionSnapshot {
            tabs: self.tabs.clone(),
            active_tab_id: self.active_tab_id.clone(),
            visible,
        }
    }

    /// F4-EVICT (2026-08-02): a aba está despejada (webview destruído,
    /// entrada preservada)? Usado pelo reativador para decidir recriar
    /// vs. erro, e pelo create_webview_with_id para não duplicar a
    /// entrada na reativação.
    pub fn tab_evicted(&self, id: &str) -> bool {
        self.tabs.iter().any(|tab| tab.id == id && tab.evicted)
    }

    /// F4-EVICT (2026-08-02): snapshot da entrada da aba (id, url,
    /// title) — o que sobrevive ao despejo. None se a aba não existe.
    pub fn tab_snapshot(&self, id: &str) -> Option<&BrowserTabSnapshot> {
        self.tabs.iter().find(|tab| tab.id == id)
    }

    /// F4-EVICT (2026-08-02): restaura a URL da entrada da aba (o evict
    /// navega para about:blank para matar mídia — a URL original precisa
    /// ser reposta para a reativação navegar de volta).
    pub fn set_tab_url(&mut self, id: &str, url: String) -> Result<(), SessionError> {
        let tab = self.tabs.iter_mut().find(|tab| tab.id == id)
            .ok_or_else(|| SessionError::UnknownTab(id.into()))?;
        tab.url = url;
        Ok(())
    }

    /// F4-EVICT (2026-08-02): remove a entrada da aba do session sem
    /// re-ativar vizinhos (usado pela reativação: a entrada evicted é
    /// removida para o attach_message_handler poder re-inseri-la fresh).
    pub fn remove_tab(&mut self, id: &str) -> Option<BrowserTabSnapshot> {
        let index = self.tabs.iter().position(|tab| tab.id == id)?;
        let was_active = self.active_tab_id.as_deref() == Some(id);
        let removed = self.tabs.remove(index);
        if was_active {
            self.active_tab_id = self.tabs.get(index)
                .or_else(|| index.checked_sub(1).and_then(|left| self.tabs.get(left)))
                .map(|tab| tab.id.clone());
        }
        Some(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> BrowserTabSnapshot {
        BrowserTabSnapshot::blank(id.into(), format!("verboo-browser-{id}"))
    }

    #[test]
    fn closing_active_tab_selects_right_then_left_and_last_tab_empties_session() {
        let mut model = BrowserSessionModel::default();
        model.insert_and_activate(tab("a")).unwrap();
        model.insert_and_activate(tab("b")).unwrap();
        model.insert_and_activate(tab("c")).unwrap();
        model.activate("b").unwrap();

        let middle = model.close("b").unwrap();
        assert_eq!(middle.next_active.as_deref(), Some("c"));
        assert!(!middle.session_empty);

        model.close("c").unwrap();
        assert_eq!(model.active_id(), Some("a"));

        let last = model.close("a").unwrap();
        assert!(last.session_empty);
        assert_eq!(model.active_id(), None);
    }

    #[test]
    fn navigation_generation_invalidates_old_results() {
        let mut model = BrowserSessionModel::default();
        model.insert_and_activate(tab("a")).unwrap();
        let first = model.begin_navigation("a", "https://one.test".into()).unwrap();
        let second = model.begin_navigation("a", "https://two.test".into()).unwrap();
        assert!(!model.is_current_generation("a", first));
        assert!(model.is_current_generation("a", second));
    }

    #[test]
    fn duplicate_ids_and_unknown_activation_are_rejected_without_mutation() {
        let mut model = BrowserSessionModel::default();
        model.insert_and_activate(tab("a")).unwrap();
        let before = model.snapshot(false);
        assert_eq!(
            model.insert_and_activate(tab("a")).unwrap_err(),
            SessionError::DuplicateTab("a".into())
        );
        assert_eq!(
            model.activate("missing").unwrap_err(),
            SessionError::UnknownTab("missing".into())
        );
        assert_eq!(model.snapshot(false), before);
    }

    #[test]
    fn session_snapshot_serializes_to_camel_case_json() {
        let mut model = BrowserSessionModel::default();
        model.insert_and_activate(tab("a")).unwrap();
        {
            let x = model.tab_mut("a").unwrap();
            x.can_go_back = true;
            x.can_go_forward = false;
            x.recoverable_error = Some("net err".into());
        }
        let snap = model.snapshot(true);
        let json = serde_json::to_value(&snap).unwrap();
        let obj = json.as_object().unwrap();

        assert!(obj.contains_key("activeTabId"), "expected camelCase activeTabId");
        assert!(obj.contains_key("visible"), "expected camelCase visible");

        let tabs = obj["tabs"].as_array().unwrap();
        let tab0 = tabs[0].as_object().unwrap();
        assert!(tab0.contains_key("canGoBack"));
        assert!(tab0.contains_key("canGoForward"));
        assert_eq!(tab0["canGoBack"], serde_json::json!(true));
        assert_eq!(tab0["canGoForward"], serde_json::json!(false));
        assert!(tab0.contains_key("recoverableError"));
        assert_eq!(tab0["recoverableError"], serde_json::json!("net err"));
        assert!(tab0.contains_key("loading"));
        assert!(tab0.contains_key("generation"));
    }
}
