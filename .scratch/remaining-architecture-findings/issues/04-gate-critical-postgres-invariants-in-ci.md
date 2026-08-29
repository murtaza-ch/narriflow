# 04 — Gate critical PostgreSQL invariants in CI

**What to build:** Turn the six critical disposable-schema database drills into permanent CI gates while keeping the default developer test loop fast. Every pull request must prove Workflow Run, Upload Session, Workspace Billing, Social Publication Attempt, Clip Editor Document Persistence, and Authenticated Request Policy database behavior against isolated PostgreSQL state.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] CI runs the Workflow Run, Upload Session, Workspace Billing, Social Publication Attempt, Clip Editor Document Persistence, and Authenticated Request Policy disposable-schema commands.
- [ ] Each database suite receives isolated PostgreSQL state and cannot depend on data, migrations, or cleanup from another suite.
- [ ] Database suites run in parallel through stable named jobs or a matrix rather than serializing all six migration drills in the main fast-check job.
- [ ] Every runner applies the required migration chain before tests and removes its disposable schema or service state on both success and failure.
- [ ] A database test failure, migration failure, setup failure, or cleanup failure produces a failed CI job rather than a skipped or successful gate.
- [ ] The fast unit-test job does not inherit database enablement flags that would accidentally rerun integration suites against unprepared state.
- [ ] The existing Workflow Run database gate is not run twice after the new job structure lands.
- [ ] Production dependency audit and production build remain required CI work and are not replaced by the database matrix.
- [ ] Job output identifies the failing domain module while preserving database credentials and other secrets.
- [ ] Local documentation lists the exact fast and database commands an implementer must run before handoff.
- [ ] CI configuration validation and one complete run prove all six database jobs pass independently.

