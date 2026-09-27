# @kitsyuu/contracts

Validation schemas (zod), shared types, error classes and the **order workflow** (`ORDER_TRANSITIONS_BY_ACTOR`, `canTransitionAs`). This is the only shared package browser code may import.

Commerce inputs (M7) only describe what the customer wants (product, size, quantity, which saved address) and the total they were shown; prices and totals are always resolved on the server.
