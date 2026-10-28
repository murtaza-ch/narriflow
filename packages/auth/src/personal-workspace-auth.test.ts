// Provisioning and Workspace-resolution tests replace `@narriflow/db/client`.
// They live in a fixture so the web suite can keep running them in an isolated
// process; importing it here runs the same tests under `bun test packages/auth`.
import "../test-fixtures/personal-workspace-auth";
