use super::*;

pub(super) fn terminal_effects(name: &NodeName, incoming: &Flow) -> Effects {
    Effects {
        definite_nodes: BTreeSet::from([name.clone()]),
        exit_failed: incoming.failed.clone(),
        ..Effects::default()
    }
}

pub(super) fn node_identity(node: &GraphNode) -> usize {
    std::ptr::from_ref(node).cast::<()>() as usize
}

pub(super) fn parallel_required_completions(join: &Join, branch_count: usize) -> u64 {
    match join {
        Join::All {} => branch_count as u64,
        Join::Any {} | Join::First { .. } => 1,
        Join::Quorum { count } => count.get(),
    }
}

pub(super) fn merge_parallel_scenarios(
    branches: &[Effects],
    required: u64,
    scenarios: &[BTreeSet<usize>],
) -> Effects {
    let mut merged = Effects::default();
    for branch in branches {
        merged
            .possible_writes
            .extend(branch.possible_writes.clone());
        merge_possible_write_types(
            &mut merged.possible_write_types,
            &branch.possible_write_types,
        );
    }

    if !scenarios.is_empty() {
        merged.definite_nodes = parallel_definite_nodes(branches, required, scenarios);
        merged.unavailable_nodes = branches
            .iter()
            .flat_map(|branch| branch.unavailable_nodes.iter().cloned())
            .collect();
        for branch in branches {
            merge_conditional_nodes(&mut merged.conditional_nodes, &branch.conditional_nodes);
        }
        retain_conditional_nodes(&mut merged.conditional_nodes, &merged.definite_nodes);
        merged.definite_writes = parallel_definite_writes(branches, required, scenarios);
        merged.outcome_writes = parallel_outcome_writes(branches, required, scenarios);
        merged.outcome_order = branches
            .iter()
            .flat_map(|branch| branch.outcome_order.iter())
            .filter(|name| merged.outcome_writes.contains_key(*name))
            .cloned()
            .collect();
        merged.parallel_definition_effects =
            parallel_definition_effects(branches, required, scenarios);
        merged.exit_failed = scenarios
            .iter()
            .flat_map(|scenario| scenario.iter())
            .flat_map(|index| branches[*index].exit_failed.clone())
            .collect();
        merged.falls_through = true;
    }
    merged
}

pub(super) fn parallel_definition_effects(
    branches: &[Effects],
    required: u64,
    scenarios: &[BTreeSet<usize>],
) -> Vec<ParallelDefinitionEffect> {
    let candidates = branches
        .iter()
        .flat_map(|branch| branch.parallel_definition_effects.iter().cloned())
        .collect::<Vec<_>>();
    let mut definite = Vec::new();
    for candidate in candidates {
        if definite.contains(&candidate) {
            continue;
        }
        let guaranteed = scenarios.iter().all(|scenario| {
            parallel_fact_is_definite(scenario, required, |index| {
                branches[index]
                    .parallel_definition_effects
                    .contains(&candidate)
            })
        });
        if guaranteed {
            definite.push(candidate);
        }
    }
    definite
}

pub(super) fn parallel_definite_nodes(
    branches: &[Effects],
    required: u64,
    scenarios: &[BTreeSet<usize>],
) -> BTreeSet<NodeName> {
    let candidates = branches
        .iter()
        .flat_map(|branch| branch.definite_nodes.iter().cloned())
        .collect::<BTreeSet<_>>();
    candidates
        .into_iter()
        .filter(|name| {
            scenarios.iter().all(|scenario| {
                parallel_fact_is_definite(scenario, required, |index| {
                    branches[index].definite_nodes.contains(name)
                })
            })
        })
        .collect()
}

pub(super) fn parallel_definite_writes(
    branches: &[Effects],
    required: u64,
    scenarios: &[BTreeSet<usize>],
) -> Writes {
    let candidates = branches
        .iter()
        .flat_map(|branch| branch.definite_writes.keys().cloned())
        .collect::<BTreeSet<_>>();
    candidates
        .into_iter()
        .filter_map(|path| {
            let guaranteed = scenarios.iter().all(|scenario| {
                parallel_fact_is_definite(scenario, required, |index| {
                    branches[index].definite_writes.contains_key(&path)
                })
            });
            let providers = scenarios
                .iter()
                .flat_map(|scenario| scenario.iter())
                .filter_map(|index| branches[*index].definite_writes.get(&path))
                .collect::<Vec<_>>();
            guaranteed
                .then(|| intersect_write_fact_set(&providers))
                .flatten()
                .map(|write| (path, write))
        })
        .collect()
}

pub(super) fn parallel_outcome_writes(
    branches: &[Effects],
    required: u64,
    scenarios: &[BTreeSet<usize>],
) -> OutcomeWrites {
    let candidates = branches
        .iter()
        .flat_map(|branch| {
            branch
                .outcome_writes
                .iter()
                .flat_map(|(name, writes)| writes.keys().cloned().map(|path| (name.clone(), path)))
        })
        .collect::<BTreeSet<_>>();
    let mut merged = OutcomeWrites::new();
    for (name, path) in candidates {
        let guaranteed = scenarios.iter().all(|scenario| {
            parallel_fact_is_definite(scenario, required, |index| {
                branches[index]
                    .outcome_writes
                    .get(&name)
                    .is_some_and(|writes| writes.contains_key(&path))
            })
        });
        let providers = scenarios
            .iter()
            .flat_map(|scenario| scenario.iter())
            .filter_map(|index| {
                branches[*index]
                    .outcome_writes
                    .get(&name)
                    .and_then(|writes| writes.get(&path))
            })
            .collect::<Vec<_>>();
        if guaranteed {
            if let Some(write) = intersect_write_fact_set(&providers) {
                merged.entry(name.clone()).or_default().insert(path, write);
            }
        }
    }
    merged
}

pub(super) fn parallel_fact_is_definite(
    completing: &BTreeSet<usize>,
    required: u64,
    provides: impl Fn(usize) -> bool,
) -> bool {
    (completing.iter().filter(|index| !provides(**index)).count() as u64) < required
}

pub(super) fn intersect_write_fact_set(writes: &[&WriteFact]) -> Option<WriteFact> {
    let (first, rest) = writes.split_first()?;
    rest.iter().try_fold((*first).clone(), |common, write| {
        intersect_write_facts(&common, write)
    })
}

pub(super) fn merge_alternatives(branches: &[Effects]) -> Effects {
    let completing = branches
        .iter()
        .filter(|branch| branch.falls_through)
        .collect::<Vec<_>>();
    let Some(first) = completing.first() else {
        let mut possible_write_types = BTreeMap::new();
        for branch in branches {
            merge_possible_write_types(&mut possible_write_types, &branch.possible_write_types);
        }
        return Effects {
            possible_writes: branches
                .iter()
                .flat_map(|branch| branch.possible_writes.clone())
                .collect(),
            possible_write_types,
            ..Effects::default()
        };
    };
    let mut definite_nodes = first.definite_nodes.clone();
    let mut definite_writes = first.definite_writes.clone();
    let mut outcome_writes = first.outcome_writes.clone();
    let mut outcome_order = first.outcome_order.clone();
    let mut parallel_definition_effects = first.parallel_definition_effects.clone();
    let mut unavailable_nodes = first.unavailable_nodes.clone();
    let mut conditional_nodes = first.conditional_nodes.clone();
    let mut possible_writes = BTreeMap::new();
    let mut possible_write_types = BTreeMap::new();
    let mut exit_failed = BTreeSet::new();
    let completion =
        CompletionPredicate::any(completing.iter().map(|branch| branch.completion.clone()));
    for branch in branches {
        possible_writes.extend(branch.possible_writes.clone());
        merge_possible_write_types(&mut possible_write_types, &branch.possible_write_types);
        if branch.falls_through {
            CommonEffects {
                definite_nodes: &mut definite_nodes,
                definite_writes: &mut definite_writes,
                outcome_writes: &mut outcome_writes,
                parallel_definition_effects: &mut parallel_definition_effects,
                conditional_nodes: &mut conditional_nodes,
            }
            .retain(branch);
            unavailable_nodes.extend(branch.unavailable_nodes.clone());
            exit_failed.extend(branch.exit_failed.clone());
        }
    }
    retain_conditional_nodes(&mut conditional_nodes, &definite_nodes);
    outcome_order.retain(|name| outcome_writes.contains_key(name));
    Effects {
        definite_nodes,
        unavailable_nodes,
        conditional_nodes,
        definite_writes,
        possible_writes,
        possible_write_types,
        outcome_writes,
        outcome_order,
        parallel_definition_effects,
        exit_failed,
        falls_through: true,
        completion,
    }
}

struct CommonEffects<'a> {
    definite_nodes: &'a mut BTreeSet<NodeName>,
    definite_writes: &'a mut Writes,
    outcome_writes: &'a mut OutcomeWrites,
    parallel_definition_effects: &'a mut Vec<ParallelDefinitionEffect>,
    conditional_nodes: &'a mut BTreeMap<NodeName, BTreeSet<NodeName>>,
}

impl CommonEffects<'_> {
    fn retain(self, branch: &Effects) {
        self.definite_nodes
            .retain(|name| branch.definite_nodes.contains(name));
        self.definite_writes.retain(|path, write| {
            let Some(other) = branch.definite_writes.get(path) else {
                return false;
            };
            let Some(common) = intersect_write_facts(write, other) else {
                return false;
            };
            *write = common;
            true
        });
        self.outcome_writes.retain(|name, writes| {
            let Some(other) = branch.outcome_writes.get(name) else {
                return false;
            };
            writes.retain(|path, write| {
                let Some(other) = other.get(path) else {
                    return false;
                };
                let Some(common) = intersect_write_facts(write, other) else {
                    return false;
                };
                *write = common;
                true
            });
            !writes.is_empty()
        });
        self.parallel_definition_effects.retain(|effect| {
            branch
                .parallel_definition_effects
                .iter()
                .any(|other| other == effect)
        });
        self.conditional_nodes.retain(|owner, nodes| {
            let Some(other) = branch.conditional_nodes.get(owner) else {
                return false;
            };
            nodes.retain(|name| other.contains(name));
            !nodes.is_empty()
        });
    }
}

pub(super) fn merge_conditional_nodes(
    target: &mut BTreeMap<NodeName, BTreeSet<NodeName>>,
    source: &BTreeMap<NodeName, BTreeSet<NodeName>>,
) {
    for (owner, nodes) in source {
        target
            .entry(owner.clone())
            .or_default()
            .extend(nodes.clone());
    }
}

pub(super) fn retain_conditional_nodes(
    conditional: &mut BTreeMap<NodeName, BTreeSet<NodeName>>,
    definite: &BTreeSet<NodeName>,
) {
    conditional.retain(|_, nodes| {
        nodes.retain(|name| definite.contains(name));
        !nodes.is_empty()
    });
}
