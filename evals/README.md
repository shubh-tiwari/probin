# Test sets

## Query test set (`evals/query/`)

`cases.yaml` holds the requests; `apps/agent/src/agent/evals.py` runs them (`pnpm evals:query` calls it through uv). Each request goes through the
real agent loop against the running stack: the dev workspace's catalog, and the
Query API for dry runs. Nothing is saved.

```sh
make dev                 # the stack must be up, with the demo services sending data
pnpm evals:query         # run every case
```

### Reading the result

| Line                                    | Meaning                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passed the dry run on the first attempt | The phase 1 gate. Of the cases that should end in a panel, how many produced a query that ran and returned data on the first try. The gate is 90%.                            |
| Fully correct                           | Cases where everything matched: the outcome, the questions asked, the range, the chart type, the stated assumptions, and the data (compared with the case's reference query). |
| Names outside the catalog               | How often a model wrote a metric or label that the catalog search had not returned. These are caught in code before any dry run. "Delivered" must be none.                    |
| Rules broken                            | Must be 0 with any model. A delivered query outside the catalog, a delivered query that skipped the dry run, or more than two questions. The run fails if this is not 0.      |
| Model cost                              | From the provider's reported cost per call. This is the input for pricing.                                                                                                    |

### With and without a model key

- **No `OPENROUTER_API_KEY`:** the run uses the built-in stand-in (keyword rules and
  query templates, no model calls, no cost). It proves the loop, the guards and the
  isolation work end to end. Its pass rate says nothing about the product. This is
  what continuous integration runs on every push.
- **With a key:** real models are called. Set `EVAL_BUDGET` to a spend cap first; the
  run refuses to start without one and stops when it is reached.

```sh
EVAL_BUDGET=2 pnpm evals:query --gate               # the configured models; fail under 90%
EVAL_BUDGET=2 pnpm evals:query --model <model id>   # one model for every task
EVAL_BUDGET=2 pnpm evals:query --strategy auto      # OpenRouter's own routing
EVAL_BUDGET=20 pnpm evals:query --record-eligibility
```

`--record-eligibility` runs the whole set once per candidate model in the models
file and writes `evals/eligibility.json`. A model is eligible for its tier when it
meets the gate, is fully correct on 90% of cases, and breaks no rule. The router
uses only eligible models, so **with a key, nothing works until this has been run
once.** Commit the file it writes.

### Adding a case

Add an entry to `cases.yaml`:

- `request`: what a person would type. Write it the way people write.
- `answers`: the answer to give for each question the agent may ask
  (`service`, `endpoint`, `percentile`, `requests`), by the option's value.
- `expect.outcome`: `draft`, or `no_match` when the catalog has nothing for it.
- `expect.reference`: for a draft, a query that gives the right answer. The agent's
  query may be written differently; it passes if it returns the same data.
- Optional: `asks` (the exact questions, in order), `range`, `type`, `assumptions`.

Check the reference query runs before committing: paste it into the metrics store's
UI at <http://localhost:8428/vmui>.

## Review test set

Phase 5: seeded slow endpoints and convention breaks in the demo services.
