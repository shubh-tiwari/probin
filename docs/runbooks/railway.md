# Runbook: deploying to Railway

Two setups, from the same repository:

| Setup    | What it is                                                                                                                                      | You need                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Demo** | The whole product with stand-ins for Slack, GitHub and Stripe, two demo services and live traffic. Anyone with the link can sign in and try it. | A Railway account                                                           |
| **Real** | The product for real teams: your own Slack app, GitHub App and Stripe account. No stand-ins, no demo services.                                  | A Railway account, and admin access to a Slack workspace, GitHub and Stripe |

Railway runs each part as its own service from this repository. Every Probin service uses the
one app image (`infra/docker/app.Dockerfile`); the `APP` variable picks which service it starts
(`infra/docker/start.sh`). The metrics store, the collector and the demo services have small
images in `infra/railway/`. Each service is configured entirely by its variables, which
`pnpm railway:env` writes for you.

Railway bills by usage. The demo runs about 15 services all the time, which is beyond the free
trial; expect a paid plan (see railway.com/pricing).

## Before you start

1. Push this repository to GitHub, and sign in to [railway.com](https://railway.com) with GitHub.
2. Run the generator for your setup. It writes `.railway/<setup>/`, which git ignores:

   ```sh
   pnpm railway:env demo     # or: pnpm railway:env real (see "The real setup" first)
   ```

   - `services.md`: the services to create, which ones are public, and notes.
   - `<service>.env`: the variables for each service, ready to paste.
   - `secrets.env`: secrets generated for this setup. Running the generator again reuses them.

## Creating the project

1. In Railway: **New Project → Deploy from GitHub repo**, and pick this repository. Rename the
   service it creates to `query-api`.
2. Add the database: **+ Create → Database → PostgreSQL**. Keep its name, `Postgres`.
3. Add every other service in `services.md`: **+ Create → GitHub Repo**, the same repository,
   then rename it. **Names must match exactly**: the services find each other by name.
4. For each service, open **Variables → Raw Editor**, paste its `<service>.env`, and save.
5. On `metrics-store`: **right-click → Attach volume**, mount path `/storage`.
6. For each service marked public: **Settings → Networking → Generate Domain**, port `8080`.
7. Deploy (Railway asks to apply the changes). The first build takes a few minutes.

What happens on the first start:

- `ingest` applies the database migrations. Other services may restart once or twice until the
  tables exist; that is expected.
- In the demo, `ingest` then creates the demo workspace and registers the demo services.
  Starter dashboards appear a minute or two after the demo services first send data.

## The demo setup

Open the `web` service's domain and choose **Sign in with Slack**. The stand-in Slack signs you in
as Alice, the demo admin. Then:

- **Dashboard**: pick **checkout** or **inventory** from the dashboard menu, or ask for a chart.
- **Review**: **Settings → GitHub → Connect GitHub** (the stand-in approves at once), then
  **Review → Run the bottleneck report**.
- **Slack**: the stand-in Slack has no chat window. Send it a mention with
  `curl -X POST https://<slack-fake domain>/fake/mention -H 'content-type: application/json' -d '{"text": "latency of checkout"}'`;
  see the [Slack runbook](phase-2.md) for the rest.

Things to know before you share the link:

- Anyone with the link can sign in as the demo admin and change the demo workspace. Treat it as
  a public sandbox, and redeploy `ingest` to re-seed it.
- With no `OPENROUTER_API_KEY`, the built-in stand-in answers requests and nothing costs money.
  If you add a key to the demo, anyone can spend it up to the workspace's model budget.
- The stand-in endpoints that act as people (`/fake/...` on `slack-fake` and `github-fake`) are
  public too.

## The real setup

Create the apps after the Railway domains exist, because each app needs those addresses.

1. **Create the services first**, without variables: follow "Creating the project" steps 1–3,
   leaving out `slack-fake`, `stripe-fake`, `github-fake` and the `demo-*` services. Generate
   domains for `web`, `ingest`, `slack` and `review`. They will fail to start until step 6.
2. **Slack.** Run
   `pnpm slack:manifest https://<slack domain> https://<web domain>` and create the app at
   [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest**. The
   second address lets people sign in to the web tool with Slack.
3. **GitHub.** Create a GitHub App ([github.com/settings/apps/new](https://github.com/settings/apps/new)):
   - Webhook URL `https://<review domain>/github/webhook`, with a secret you choose.
   - Setup URL `https://<web domain>/github/setup`.
   - Permissions: Contents (read), Pull requests (read and write), Deployments (read),
     Metadata (read). Events: **Pull request** and **Deployment status**.
   - Generate a private key and save the `.pem` file outside the repository.
4. **Stripe.** In test mode first: create a product with a monthly price and note its price id
   (`price_...`). Add a webhook endpoint `https://<web domain>/billing/webhook` for the
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted` events.
5. **Plans.** Copy `config/plans.example.yaml` to `config/plans.yaml`, set your plan name, price
   and `stripe_price`, and commit it (price ids are not secrets).
6. **Variables.** Run `pnpm railway:env real` once to create `.railway/real/inputs.env`, fill it
   in (each line says where the value comes from), and run it again. Paste each `<service>.env`
   into its service, attach the volume to `metrics-store`, and deploy.
7. Open `https://<slack domain>/slack/install` and approve. That creates your workspace and shows
   its ingestion key once. Then point your services at `https://<ingest domain>` with that key
   (the skill sets this up).

To go live, repeat steps 3 and 4 with Stripe live mode and update `inputs.env`.

## Changing things later

- **New secrets:** delete `.railway/<setup>/secrets.env`, run the generator again and paste the
  new files. Changing `SECRETS_KEY` makes stored Slack tokens unreadable, so reinstall Slack after.
- **A new release:** push to the branch Railway watches; each service rebuilds.
- **Logs:** each service's **Deployments → View logs**.

## When something is wrong

| Symptom                                                                | Likely cause                                                                 | Fix                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A service logs `APP must name a service`                               | Its variables were not pasted                                                | Paste its `<service>.env` and redeploy                                                  |
| Errors like `relation "…" does not exist` right after the first deploy | Migrations had not finished                                                  | They stop once `ingest` has started; if not, check `ingest`'s log                       |
| A service cannot reach `something.railway.internal`                    | The service is named differently from the variables                          | Rename it to the exact name in `services.md`                                            |
| No data in the dashboards                                              | The collector cannot reach the store, or `ingest` cannot reach the collector | Check `otel-collector`'s log for export errors, and that `metrics-store` has its volume |
| Sign in with Slack fails (real setup)                                  | The Slack app does not list the web callback                                 | Recreate the manifest with both addresses (step 2) and update the app                   |
| Starter dashboards are empty in the demo                               | The demo services have only just started                                     | Wait a few minutes; the dashboard menu has **checkout** and **inventory**               |
