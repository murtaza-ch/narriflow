# Workspace Billing owns provider synchronization and access projection

One Workspace Billing Account stores the provider identity, verified subscription snapshot, reconciliation health, and retry ownership for one Workspace. The Workspace Billing module owns signed Stripe delivery acceptance, current-state retrieval, subscription policy, retention transitions, access projection, audit transitions, and due reconciliation behind one interface. Hono, the worker, Postgres, Stripe, the clock, and diagnostics are adapters. Stripe deliveries are notifications and never set entitlements from their payloads.

`Workspace.pricingTier` and `Workspace.status` remain the projection read by product modules. Only Workspace Billing changes that projection because of provider state. The module commits the billing snapshot, Workspace projection, Project retention changes, and append-only transition together. Claims use an immutable reconciliation attempt ID and an expiring lease; every settlement is fenced. Provider outages and catalog conflicts retain the last verified access.

## Considered options

We rejected User-level billing because one person may have different entitlements in different Workspaces; event-time ordering because Stripe delivery order is not current subscription truth; direct webhook tier writes because delivery retries and equal-second events can reverse access; a generic job framework because billing claims have their own provider and policy facts; and exposing Stripe or persistence adapters to callers because that would make callers reproduce reconciliation sequencing.

## Consequences

The public interface accepts a delivery, reconciles current or due accounts, and reads a product billing view. The production Stripe adapter retrieves the customer and the complete bounded subscription collection. Personal Workspaces fall back to active Free when paid access ends. Collaborative Workspaces with non-owner members become restricted on Free. Restricted access preserves owner billing, viewing, and downloads while blocking edits, processing, publishing, API and MCP use, and billable collaboration.
