# Migration to DSH

## Stage 0: Freeze upstream

- Pin an official DSH baseline version.
- Restore or vendor the official source tree needed for build and gates.
- Record the upstream hash and update policy.

## Stage 1: Define domain contracts

For every business domain, define:

- service definition;
- provider and consumer roles;
- commands/queries;
- agent tool mapping (if AI may invoke it);
- persistence provider;
- error contract;
- acceptance criteria.

## Stage 2: Replace routes by domain

Do not run the old backend and the new DSH domain side by side as equal source of truth.
For each route:

1. Implement the DSH domain service.
2. Adapt the frontend request to the DSH gateway.
3. Verify the page and the agent tool both use the same capability.
4. Delete the old route implementation.

## Stage 3: Remove legacy runtimes

- Decommission `bosom-friend-harness`.
- Remove direct model calls from product business code.
- Remove standalone product JSON/backend services.
- Keep only DSH session logs and DSH-backed product stores.

## Stage 4: Release gates

No module enters 0.2.0 unless:

- unit and integration tests pass;
- UI action and agent tool path both pass;
- refresh persistence passes;
- process leak and installer checks pass.
