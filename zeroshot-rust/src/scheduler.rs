use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use thiserror::Error;
use std::sync::Mutex;

use crate::cluster_ledger::ExecutionId;
use crate::execution::{
    DispatchFence, ExecutionCommand, ExecutionControl, ExecutionRuntime, ExecutionTargetRef,
    WorkspaceAccessMode,
};

const DEFAULT_GLOBAL_ACTIVE: usize = 32;
const DEFAULT_PER_CLUSTER_ACTIVE: usize = 8;
const DEFAULT_PER_LANE_ACTIVE: usize = 4;
const DEFAULT_MAX_QUEUED: usize = 1_024;
const MAX_GLOBAL_ACTIVE: usize = 1_024;
const MAX_TOTAL_QUEUED: usize = 16_384;
const BUILTIN_LANE: &str = "builtin";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SchedulerConfig {
    pub global_active: usize,
    pub per_cluster_active: usize,
    pub per_lane_active: usize,
    pub max_queued: usize,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            global_active: DEFAULT_GLOBAL_ACTIVE,
            per_cluster_active: DEFAULT_PER_CLUSTER_ACTIVE,
            per_lane_active: DEFAULT_PER_LANE_ACTIVE,
            max_queued: DEFAULT_MAX_QUEUED,
        }
    }
}

impl SchedulerConfig {
    pub fn validate(self) -> Result<Self, SchedulerError> {
        if self.global_active == 0
            || self.per_cluster_active == 0
            || self.per_lane_active == 0
            || self.max_queued == 0
        {
            return Err(SchedulerError::InvalidConfig(
                "all scheduler limits must be greater than zero".to_owned(),
            ));
        }
        if self.global_active > MAX_GLOBAL_ACTIVE {
            return Err(SchedulerError::InvalidConfig(format!(
                "global active is {}; maximum is {}",
                self.global_active, MAX_GLOBAL_ACTIVE
            )));
        }
        if self.max_queued > MAX_TOTAL_QUEUED {
            return Err(SchedulerError::InvalidConfig(format!(
                "queued limit is {}; maximum is {}",
                self.max_queued, MAX_TOTAL_QUEUED
            )));
        }
        if self.per_cluster_active > self.global_active || self.per_lane_active > self.global_active
        {
            return Err(SchedulerError::InvalidConfig(
                "per-cluster and per-lane limits must be less than or equal to the global limit"
                    .to_owned(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum SchedulerError {
    #[error("invalid scheduler configuration: {0}")]
    InvalidConfig(String),
    #[error("scheduler queue is full")]
    QueueFull,
    #[error("scheduler sequence overflowed")]
    SequenceOverflow,
}

#[derive(Clone)]
pub struct FairScheduler {
    runtime: Arc<dyn ExecutionRuntime>,
    config: SchedulerConfig,
    state: Arc<Mutex<SchedulerState>>,
}

#[derive(Default)]
struct SchedulerState {
    next_sequence: u64,
    queue: BTreeMap<u64, QueuedExecution>,
    active: BTreeMap<ExecutionKey, ActiveExecution>,
    active_global: usize,
    active_by_cluster: BTreeMap<String, usize>,
    active_by_lane: BTreeMap<String, usize>,
    workspace: BTreeMap<String, WorkspaceOccupancy>,
    last_lane: Option<String>,
    last_cluster: BTreeMap<String, String>,
}

type ExecutionKey = (ExecutionId, DispatchFence);

struct QueuedExecution {
    lane: String,
    cluster: String,
    workspace: String,
    mode: WorkspaceAccessMode,
    command: ExecutionCommand,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct WorkspaceOccupancy {
    readers: usize,
    exclusive: bool,
}

struct StartedExecution {
    execution: ExecutionId,
    dispatch_fence: DispatchFence,
    cluster: String,
    lane: String,
    workspace: String,
    mode: WorkspaceAccessMode,
    command: ExecutionCommand,
}

struct ActiveExecution {
    cluster: String,
    lane: String,
    workspace: String,
    mode: WorkspaceAccessMode,
}

impl FairScheduler {
    pub fn new(
        runtime: Arc<dyn ExecutionRuntime>,
        config: SchedulerConfig,
    ) -> Result<Self, SchedulerError> {
        Ok(Self {
            runtime,
            config: config.validate()?,
            state: Arc::new(Mutex::new(SchedulerState::default())),
        })
    }

    pub async fn submit(&self, command: ExecutionCommand) -> Result<u64, SchedulerError> {
        let sequence = {
            let mut state = self
                .state
                .lock()
                .expect("scheduler mutex must not be poisoned");
            if state.queue.len() >= self.config.max_queued {
                return Err(SchedulerError::QueueFull);
            }
            state.next_sequence = state
                .next_sequence
                .checked_add(1)
                .ok_or(SchedulerError::SequenceOverflow)?;
            let sequence = state.next_sequence;
            let queued = QueuedExecution::new(command);
            state.queue.insert(sequence, queued);
            sequence
        };
        self.drain();
        Ok(sequence)
    }

    pub async fn cancel_queued(&self, control: &ExecutionControl) -> bool {
        let key = (control.execution(), control.dispatch_fence());
        let mut state = self
            .state
            .lock()
            .expect("scheduler mutex must not be poisoned");
        let sequence = state.queue.iter().find_map(|(sequence, queued)| {
            (queued.command.execution(), queued.command.dispatch_fence())
                .eq(&key)
                .then_some(*sequence)
        });
        sequence.is_some_and(|sequence| state.queue.remove(&sequence).is_some())
    }

    pub async fn queued_len(&self) -> usize {
        self.state
            .lock()
            .expect("scheduler mutex must not be poisoned")
            .queue
            .len()
    }

    pub async fn active_len(&self) -> usize {
        self.state
            .lock()
            .expect("scheduler mutex must not be poisoned")
            .active_global
    }

    pub async fn release_terminal(&self, control: &ExecutionControl) -> bool {
        let released = {
            let mut state = self
                .state
                .lock()
                .expect("scheduler mutex must not be poisoned");
            state.release((control.execution(), control.dispatch_fence()))
        };
        if released {
            self.drain();
        }
        released
    }

    fn drain(&self) {
        loop {
            let Some(started) = self.try_start_next() else {
                return;
            };
            let runtime = Arc::clone(&self.runtime);
            let command = started.command;
            tokio::spawn(async move {
                let _ = runtime.dispatch(command).await;
            });
        }
    }

    fn try_start_next(&self) -> Option<StartedExecution> {
        let mut state = self
            .state
            .lock()
            .expect("scheduler mutex must not be poisoned");
        if state.active_global >= self.config.global_active || state.queue.is_empty() {
            return None;
        }
        let started = state.pick_next(&self.config)?;
        state.activate(&started);
        Some(started)
    }
}

impl QueuedExecution {
    fn new(command: ExecutionCommand) -> Self {
        Self {
            lane: lane_key(command.target()),
            cluster: command.cluster().as_str().to_owned(),
            workspace: command.workspace().lease_key().as_str().to_owned(),
            mode: command.workspace().mode(),
            command,
        }
    }
}

impl SchedulerState {
    fn pick_next(&mut self, config: &SchedulerConfig) -> Option<StartedExecution> {
        let lanes = self.nonempty_lanes();
        if lanes.is_empty() {
            return None;
        }
        let lane_start = next_index_after(&lanes, self.last_lane.as_deref());
        for lane_offset in 0..lanes.len() {
            let lane_index = (lane_start + lane_offset) % lanes.len();
            let lane = &lanes[lane_index];
            if self.active_by_lane.get(lane).copied().unwrap_or(0) >= config.per_lane_active {
                continue;
            }
            let clusters = self.nonempty_clusters(lane);
            if clusters.is_empty() {
                continue;
            }
            let start_cluster =
                next_index_after(&clusters, self.last_cluster.get(lane).map(String::as_str));
            for cluster_offset in 0..clusters.len() {
                let cluster_index = (start_cluster + cluster_offset) % clusters.len();
                let cluster = &clusters[cluster_index];
                if self.active_by_cluster.get(cluster).copied().unwrap_or(0)
                    >= config.per_cluster_active
                {
                    continue;
                }
                let Some(sequence) = self
                    .queue
                    .iter()
                    .filter(|(_, queued)| queued.lane == *lane && queued.cluster == *cluster)
                    .map(|(sequence, _)| *sequence)
                    .find(|sequence| self.workspace_available(&self.queue[sequence]))
                else {
                    continue;
                };
                let queued = self.queue.remove(&sequence)?;
                self.last_lane = Some(lane.clone());
                self.last_cluster.insert(lane.clone(), cluster.clone());
                return Some(StartedExecution {
                    execution: queued.command.execution(),
                    dispatch_fence: queued.command.dispatch_fence(),
                    cluster: queued.cluster,
                    lane: queued.lane,
                    workspace: queued.workspace,
                    mode: queued.mode,
                    command: queued.command,
                });
            }
        }
        None
    }

    fn activate(&mut self, started: &StartedExecution) {
        self.active.insert(
            (started.execution, started.dispatch_fence),
            ActiveExecution {
                cluster: started.cluster.clone(),
                lane: started.lane.clone(),
                workspace: started.workspace.clone(),
                mode: started.mode,
            },
        );
        self.active_global += 1;
        *self
            .active_by_cluster
            .entry(started.cluster.clone())
            .or_default() += 1;
        *self.active_by_lane.entry(started.lane.clone()).or_default() += 1;
        let entry = self.workspace.entry(started.workspace.clone()).or_default();
        match started.mode {
            WorkspaceAccessMode::ReadOnly => entry.readers += 1,
            WorkspaceAccessMode::Exclusive => entry.exclusive = true,
        }
    }

    fn release(&mut self, key: ExecutionKey) -> bool {
        let Some(active) = self.active.remove(&key) else {
            return false;
        };
        self.active_global -= 1;
        decrement_map(&mut self.active_by_cluster, &active.cluster);
        decrement_map(&mut self.active_by_lane, &active.lane);
        if let Some(occupancy) = self.workspace.get_mut(&active.workspace) {
            match active.mode {
                WorkspaceAccessMode::ReadOnly => occupancy.readers -= 1,
                WorkspaceAccessMode::Exclusive => occupancy.exclusive = false,
            }
            if occupancy.readers == 0 && !occupancy.exclusive {
                self.workspace.remove(&active.workspace);
            }
        }
        true
    }

    fn workspace_available(&self, queued: &QueuedExecution) -> bool {
        let occupancy = self
            .workspace
            .get(&queued.workspace)
            .copied()
            .unwrap_or_default();
        match queued.mode {
            WorkspaceAccessMode::ReadOnly => !occupancy.exclusive,
            WorkspaceAccessMode::Exclusive => !occupancy.exclusive && occupancy.readers == 0,
        }
    }

    fn nonempty_lanes(&self) -> Vec<String> {
        self.queue
            .values()
            .map(|queued| queued.lane.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    fn nonempty_clusters(&self, lane: &str) -> Vec<String> {
        self.queue
            .values()
            .filter(|queued| queued.lane == lane)
            .map(|queued| queued.cluster.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

fn decrement_map(map: &mut BTreeMap<String, usize>, key: &str) {
    if let Some(value) = map.get_mut(key) {
        *value -= 1;
        if *value == 0 {
            map.remove(key);
        }
    }
}

fn lane_key(target: &ExecutionTargetRef) -> String {
    match target {
        ExecutionTargetRef::Agent(binding) => binding.provider_lane().as_str().to_owned(),
        ExecutionTargetRef::Builtin(_) => BUILTIN_LANE.to_owned(),
    }
}

fn next_index_after(items: &[String], last: Option<&str>) -> usize {
    let Some(last) = last else {
        return 0;
    };
    items
        .iter()
        .position(|item| item == last)
        .map(|index| (index + 1) % items.len())
        .unwrap_or(0)
}
