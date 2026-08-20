use super::*;

#[derive(Clone, Default)]
pub(super) struct ActivityRegistry {
    state: Arc<Mutex<ActivityState>>,
}

#[derive(Default)]
struct ActivityState {
    active: BTreeMap<ActiveKey, ActiveInvocation>,
    closed_runs: BTreeSet<RunId>,
}

struct ActiveInvocation {
    cancel: watch::Sender<bool>,
    session: Option<ManagedSession>,
    done: watch::Sender<bool>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ActiveKey {
    run_id: RunId,
    execution: ExecutionId,
}

pub(super) struct ActivityToken {
    registry: ActivityRegistry,
    key: ActiveKey,
}

impl ActivityRegistry {
    pub(super) async fn register(
        &self,
        reference: &ExecutionRef,
        cancel: watch::Sender<bool>,
    ) -> Result<ActivityToken, NodeRunnerError> {
        let key = ActiveKey {
            run_id: reference.run_id.clone(),
            execution: reference.execution,
        };
        let (done, _) = watch::channel(false);
        let mut state = self.state.lock().await;
        if state.closed_runs.contains(&key.run_id) {
            return Err(NodeRunnerError::RunClosed);
        }
        match state.active.entry(key.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(ActiveInvocation {
                    cancel,
                    session: None,
                    done,
                });
            }
            std::collections::btree_map::Entry::Occupied(_) => {
                return Err(NodeRunnerError::ExecutionActive);
            }
        }
        Ok(ActivityToken {
            registry: self.clone(),
            key,
        })
    }

    pub(super) async fn begin_close(&self, run_id: &RunId) -> Vec<watch::Receiver<bool>> {
        let targets = {
            let mut state = self.state.lock().await;
            state.closed_runs.insert(run_id.clone());
            state
                .active
                .iter()
                .filter(|(key, _)| key.run_id == *run_id)
                .map(|(_, active)| {
                    (
                        active.cancel.clone(),
                        active.session.clone(),
                        active.done.subscribe(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (cancel, _, _) in &targets {
            let _ = cancel.send(true);
        }
        for (_, session, _) in &targets {
            if let Some(session) = session {
                session.close().await;
            }
        }
        targets.into_iter().map(|(_, _, done)| done).collect()
    }
}

impl ActivityToken {
    pub(super) async fn bind_session(
        &self,
        session: ManagedSession,
    ) -> Result<(), NodeRunnerError> {
        let mut state = self.registry.state.lock().await;
        if state.closed_runs.contains(&self.key.run_id) {
            return Err(NodeRunnerError::RunClosed);
        }
        let active = state
            .active
            .get_mut(&self.key)
            .ok_or(NodeRunnerError::Cancelled)?;
        active.session = Some(session);
        Ok(())
    }

    pub(super) async fn finish(self) {
        let active = self.registry.state.lock().await.active.remove(&self.key);
        if let Some(active) = active {
            let _ = active.done.send(true);
        }
    }
}

#[derive(Clone)]
pub(super) struct ManagedSession {
    inner: Arc<dyn NodeSession>,
    closed: Arc<AtomicBool>,
}

impl ManagedSession {
    fn new(inner: Arc<dyn NodeSession>) -> Self {
        Self {
            inner,
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(super) fn inner(&self) -> Arc<dyn NodeSession> {
        self.inner.clone()
    }

    async fn is_live(&self) -> bool {
        !self.closed.load(Ordering::SeqCst) && self.inner.is_live().await
    }

    async fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.inner.close().await;
        }
    }

    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.closed, &other.closed)
    }
}

#[derive(Clone)]
pub(super) struct SessionPool {
    factory: Arc<dyn SessionFactory>,
    entries: Arc<Mutex<BTreeMap<SessionKey, SessionEntry>>>,
}

impl SessionPool {
    pub(super) fn new(factory: Arc<dyn SessionFactory>) -> Self {
        Self {
            factory,
            entries: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub(super) async fn checkout(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<SessionLease, NodeRunnerError> {
        let scope = session_scope(&invocation.binding)?;
        if scope == SessionScope::Execution {
            let session = self
                .open_session(invocation, environment, cancellation)
                .await?;
            return Ok(SessionLease {
                session,
                pool: self.clone(),
                kind: SessionLeaseKind::Execution,
            });
        }

        let key = SessionKey {
            run_id: invocation.reference.run_id.clone(),
            node_instance: invocation.reference.node_instance,
        };
        loop {
            match self.checkout_action(&key).await? {
                CheckoutAction::Reuse(session) => {
                    return self.reuse(key, session, cancellation).await;
                }
                CheckoutAction::Wait(mut ready) => {
                    wait_for_open(&mut ready, cancellation).await?;
                }
                CheckoutAction::Open(ready) => {
                    let opened = self
                        .open_session(invocation, environment, cancellation)
                        .await;
                    return self.finish_open(key, ready, opened).await;
                }
            }
        }
    }

    async fn checkout_action(&self, key: &SessionKey) -> Result<CheckoutAction, NodeRunnerError> {
        let mut entries = self.entries.lock().await;
        match entries.get(key) {
            Some(SessionEntry::Lost) => Err(NodeRunnerError::SessionLost),
            Some(SessionEntry::Live(session)) => Ok(CheckoutAction::Reuse(session.clone())),
            Some(SessionEntry::Opening(ready)) => Ok(CheckoutAction::Wait(ready.subscribe())),
            None => {
                let (ready, _) = watch::channel(false);
                let ready = Arc::new(ready);
                entries.insert(key.clone(), SessionEntry::Opening(ready.clone()));
                Ok(CheckoutAction::Open(ready))
            }
        }
    }

    async fn reuse(
        &self,
        key: SessionKey,
        session: ManagedSession,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<SessionLease, NodeRunnerError> {
        let live = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancellation) => return Err(NodeRunnerError::Cancelled),
            live = session.is_live() => live,
        };
        if !live {
            self.invalidate(key, session).await;
            return Err(NodeRunnerError::SessionLost);
        }
        Ok(SessionLease {
            session,
            pool: self.clone(),
            kind: SessionLeaseKind::NodeInstance(key),
        })
    }

    async fn open_session(
        &self,
        invocation: &NodeInvocation,
        environment: &ResolvedEnvironment,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ManagedSession, NodeRunnerError> {
        let session = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancellation) => return Err(NodeRunnerError::Cancelled),
            session = self.factory.open(invocation, environment) => session?,
        };
        let session = ManagedSession::new(session);
        let live = tokio::select! {
            biased;
            _ = wait_for_cancellation(cancellation) => {
                session.close().await;
                return Err(NodeRunnerError::Cancelled);
            },
            live = session.is_live() => live,
        };
        if !live {
            session.close().await;
            return Err(NodeRunnerError::SessionOpen);
        }
        Ok(session)
    }

    async fn finish_open(
        &self,
        key: SessionKey,
        ready: Arc<watch::Sender<bool>>,
        opened: Result<ManagedSession, NodeRunnerError>,
    ) -> Result<SessionLease, NodeRunnerError> {
        let mut close = None;
        let cancelled = matches!(&opened, Err(NodeRunnerError::Cancelled));
        let result = {
            let mut entries = self.entries.lock().await;
            let still_opening = matches!(
                entries.get(&key),
                Some(SessionEntry::Opening(current)) if Arc::ptr_eq(current, &ready)
            );
            if !still_opening {
                if let Ok(session) = &opened {
                    close = Some(session.clone());
                }
                Err(if cancelled {
                    NodeRunnerError::Cancelled
                } else {
                    NodeRunnerError::SessionLost
                })
            } else {
                match opened {
                    Ok(session) => {
                        entries.insert(key.clone(), SessionEntry::Live(session.clone()));
                        Ok(SessionLease {
                            session,
                            pool: self.clone(),
                            kind: SessionLeaseKind::NodeInstance(key),
                        })
                    }
                    Err(error) => {
                        if error == NodeRunnerError::Cancelled {
                            entries.insert(key, SessionEntry::Lost);
                        } else {
                            entries.remove(&key);
                        }
                        Err(error)
                    }
                }
            }
        };
        let _ = ready.send(true);
        if let Some(session) = close {
            session.close().await;
        }
        result
    }

    async fn invalidate(&self, key: SessionKey, session: ManagedSession) {
        let mut entries = self.entries.lock().await;
        if matches!(entries.get(&key), Some(SessionEntry::Live(current)) if current.same(&session))
        {
            entries.insert(key, SessionEntry::Lost);
        }
        drop(entries);
        session.close().await;
    }

    pub(super) async fn close_run(&self, run_id: &RunId) {
        let mut entries = self.entries.lock().await;
        let keys = entries
            .keys()
            .filter(|key| key.run_id == *run_id)
            .cloned()
            .collect::<Vec<_>>();
        let entries_to_close = keys
            .into_iter()
            .filter_map(|key| match entries.insert(key, SessionEntry::Lost) {
                Some(SessionEntry::Live(session)) => Some(EntryToClose::Session(session)),
                Some(SessionEntry::Opening(ready)) => Some(EntryToClose::Opening(ready)),
                Some(SessionEntry::Lost) | None => None,
            })
            .collect::<Vec<_>>();
        drop(entries);
        for entry in entries_to_close {
            match entry {
                EntryToClose::Session(session) => session.close().await,
                EntryToClose::Opening(ready) => {
                    let _ = ready.send(true);
                }
            }
        }
    }
}

async fn wait_for_ready(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn wait_for_open(
    ready: &mut watch::Receiver<bool>,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), NodeRunnerError> {
    tokio::select! {
        biased;
        _ = wait_for_cancellation(cancellation) => Err(NodeRunnerError::Cancelled),
        _ = wait_for_ready(ready) => Ok(()),
    }
}

enum CheckoutAction {
    Reuse(ManagedSession),
    Wait(watch::Receiver<bool>),
    Open(Arc<watch::Sender<bool>>),
}

enum EntryToClose {
    Session(ManagedSession),
    Opening(Arc<watch::Sender<bool>>),
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct SessionKey {
    run_id: RunId,
    node_instance: NodeInstanceId,
}

enum SessionEntry {
    Opening(Arc<watch::Sender<bool>>),
    Live(ManagedSession),
    Lost,
}

pub(super) struct SessionLease {
    pub(super) session: ManagedSession,
    pool: SessionPool,
    kind: SessionLeaseKind,
}

impl SessionLease {
    pub(super) async fn finish(self, clean: bool) {
        match self.kind {
            SessionLeaseKind::Execution => self.session.close().await,
            SessionLeaseKind::NodeInstance(_) if clean => {}
            SessionLeaseKind::NodeInstance(key) => self.pool.invalidate(key, self.session).await,
        }
    }
}

enum SessionLeaseKind {
    Execution,
    NodeInstance(SessionKey),
}
