# Runbook: phase 5, Review

What phase 5 added and how to run it. The earlier runbooks still apply.

## What was built

| Piece                                                                                                              | Where                                               |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| GitHub App client (app JWT, installation tokens), webhook verification                                             | `apps/review/src/github.ts`                         |
| Code index: routes, their handlers and line ranges, outbound calls, manifests; cached per commit                   | `apps/review/src/indexer.ts`, table `code_index`    |
| Bottleneck report (R2), on demand and weekly (Monday 07:00 UTC)                                                    | `bottleneckReport` in `apps/review/src/analyses.ts` |
| Convention check on every pull request (R3), on the added lines only                                               | `conventionFindings`                                |
| Metrics-aware comments on pull requests that touch a measured endpoint (R4)                                        | `touchedEndpointFindings`                           |
| Post-deploy follow-up (R5): compares before and after, notes on the pull request and in Slack when something moved | `deployFindings`, job `review-deploy`               |
| Dismissals remembered (R6): a dismissed comment type is not posted again on that repository                        | `recordDecision`, memory kind `review_feedback`     |
| Review page (R7): reports, findings with evidence, Accept, Dismiss, comments                                       | `apps/web/src/views/review.tsx`                     |
| Architecture review (R8): service map from real calls, findings, `service_map` memory                              | `architectureReview`                                |
| A fake GitHub, serving the demo services as the repository `acme/shop`                                             | `apps/review/src/fake/github.ts`                    |
| Review test set: seeded slow endpoints and convention breaks                                                       | `evals/review/cases.yaml`                           |
| Acceptance check                                                                                                   | `scripts/verify-phase5.ts`                          |

## Limits that always hold

- Review reads code and never pushes commits. Its GitHub access is read-only except for comments.
- Code is kept only as the cached index (routes, handler lines, manifests), per commit.
- Every finding names the metric and time window it rests on; the review page shows them and the query.
- An endpoint is linked to its handler by `http.route` from the metrics and the route definitions in the index. With no match, the finding says it could not find the handler.

## Using it locally

1. Sign in to the web tool as Alice, open **Settings → GitHub, for Review → Connect GitHub**. The fake GitHub approves at once.
2. **Review → Run the bottleneck report** or **Review the architecture**.
3. Open a pull request on the fake repository:

```sh
curl -s -X POST http://localhost:8096/fake/pulls -H 'content-type: application/json' -d '{
  "repo": "acme/shop", "title": "Count orders per user", "installation": "<installation id>",
  "changes": { "checkout/server.cjs": "<the whole new file>" } }'
curl -s 'http://localhost:8096/fake/comments?repo=acme/shop&number=<number>'
```

The installation id is in the `github_installations` table. `pnpm verify:phase5` does all of this and is the quickest way to see it work.

## Connecting a real GitHub

1. Create a GitHub App with: Contents (read), Pull requests (read and write, for comments), Deployments (read), Metadata (read); events **Pull request** and **Deployment status**; webhook URL `<review service>/github/webhook` with a secret; setup URL `<web tool>/github/setup`.
2. Set `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_API_URL=https://api.github.com`, `GITHUB_APP_INSTALL_URL=https://github.com/apps/<app>/installations/new`, and put the app's private key in a file named by `GITHUB_APP_PRIVATE_KEY_FILE`. The key is a secret.
3. Set `REVIEW_DEPLOY_WINDOW` back to `30m` (development uses `2m`).

## When something is wrong

| Symptom                                      | Likely cause                                                                                   | Fix                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Pull requests get no comments                | The webhook is refused (401: wrong secret) or the installation is not connected to a workspace | Check the review service's log; connect GitHub again from Settings                        |
| A finding says it could not find the handler | The route in the metrics does not match a route definition in the code                         | Check the framework reports the template the code declares; Express reports `/orders/:id` |
| Nothing in the bottleneck report             | The repository has no manifest, or the services sent no data in the window                     | Add the manifest (the skill does this); widen `REVIEW_WINDOW`                             |
| A comment type stopped appearing             | Someone dismissed one on this repository                                                       | Delete the `review_feedback` entry on the Memory page                                     |

## Known limits of phase 5

- Suggested fixes come from rules about the handler's code (a loop that awaits each step, an outbound call), not from a model. A model-written suggestion is the natural next step once a model key is in place.
- The route indexer understands Express (JavaScript) and FastAPI (Python) route definitions.
- A deploy cannot change the demo services' real latency, so the before-and-after comparison is checked by unit tests; the live check confirms the deploy is received and followed up only after the window.
- Real GitHub was not used; the fake serves the same API calls.
