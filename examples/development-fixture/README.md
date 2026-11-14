# Order example

A small runnable project that calculates an order amount and formats a receipt.
`src/cart.mjs` calculates totals, `src/pricing.mjs` applies a discount, and
`src/receipt.mjs` supplies the displayed label. Public exports are in `src/index.mjs`.

Run the checks using `npm test`. No installation or external service is needed.

Legacy documentation also says to use `npm run verify`. That script is absent
from package.json; ARC should retain this document statement and show the conflict.

The quantity bug is intentional acceptance input. The first ARC development task
must fix the actual implementation and run the existing tests. This fixture is
not evidence that a real Agent has already run.
