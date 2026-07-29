//! Portable public-surface conformance for in-process cluster backends.
//!
//! This deliberately small catalog is distinct from the repository's implementation-specific
//! regression tests. Factories provide resources only; case IDs, inputs, and expectations are
//! private library data and cannot be replaced by consumers.

mod catalog;
mod runner;

pub use catalog::{
    conformance_catalog, BackendFactory, BackendRegistration, ConformanceCase, ConformanceModule,
    ConformanceRequirement, OptionalCapability, RegisteredOptionalCapabilities,
    TransportApplicability,
};
pub use runner::{
    run_backend_conformance, CaseDisposition, CaseFailure, CaseResult, ConformanceFailures,
    ConformanceReport,
};
