import { createMemory } from '@app/memory';
import { schema, type Database } from '@app/db';
import { createQueryApiClient } from '@app/query-api/client';
import { and, eq } from 'drizzle-orm';
import {
  architectureReview,
  bottleneckReport,
  conventionFindings,
  deployFindings,
  touchedEndpointFindings,
} from './analyses.js';
import type { Finding, FindingKind } from './findings.js';
import type { GitHub, Repo } from './github.js';
import { buildIndex, type CodeIndex } from './indexer.js';

export interface ReviewOptions {
  db: Database;
  github: GitHub;
  queryApiUrl: string;
  internalToken: string;
  webUrl: string;
  /** How far back numbers are read, e.g. 24h. */
  window: string;
  /** How long before and after a deploy is compared, e.g. 30m. */
  deployWindow: string;
  /** Tell people in Slack when a deploy moved the numbers. */
  notify?: (workspaceId: string, text: string) => Promise<void>;
}

const MAX_FILES = 400;
const INDEXED = /(\.(c?js|mjs|ts|py)$)|(^|\/)[a-z0-9-]+\.yaml$/;

/** Which workspace a GitHub installation belongs to. */
export async function workspaceForInstallation(db: Database, installationId: string) {
  const [row] = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.installationId, installationId))
    .limit(1);
  return row?.workspaceId;
}

export function createReviewService(options: ReviewOptions) {
  const { db } = options;
  const queryFor = (workspaceId: string) =>
    createQueryApiClient({
      url: options.queryApiUrl,
      internalToken: options.internalToken,
      workspaceId,
    });

  /** The code index at a commit, from the cache or built from the repository. */
  async function indexAt(
    workspaceId: string,
    repo: Repo,
    repository: string,
    commit: string,
  ): Promise<CodeIndex> {
    const [cached] = await db
      .select()
      .from(schema.codeIndex)
      .where(
        and(
          eq(schema.codeIndex.workspaceId, workspaceId),
          eq(schema.codeIndex.repository, repository),
          eq(schema.codeIndex.commit, commit),
        ),
      )
      .limit(1);
    if (cached) return cached.index as CodeIndex;
    const paths = (await repo.tree(repository, commit))
      .filter((p) => INDEXED.test(p) && !/(^|\/)(node_modules|\.venv|dist)\//.test(p))
      .slice(0, MAX_FILES);
    const files = new Map<string, string>();
    for (const path of paths) files.set(path, await repo.file(repository, path, commit));
    const index = buildIndex(commit, files);
    await db
      .insert(schema.codeIndex)
      .values({ workspaceId, repository, commit, index })
      .onConflictDoNothing();
    return index;
  }

  /** Comment kinds people have dismissed on this repository. Review does not repeat them (R6). */
  async function suppressed(workspaceId: string, repository: string): Promise<Set<string>> {
    const entries = await createMemory(db, workspaceId).list({ kind: 'review_feedback' });
    return new Set(
      entries
        .filter(
          (e) =>
            e.subject.startsWith(`${repository}#`) &&
            ((e.value as { dismissals?: number } | null)?.dismissals ?? 0) >= 1,
        )
        .map((e) => e.subject.slice(repository.length + 1)),
    );
  }

  const findingKey = (f: Finding) =>
    f.kind === 'convention' ? `convention:${f.evidence.rule}` : f.kind;

  /** Store a report and its findings. Returns ids, findings in order. */
  async function save(
    workspaceId: string,
    repository: string,
    kind: string,
    title: string,
    findings: Finding[],
    body: object,
    pullRequest?: number,
  ) {
    const [report] = await db
      .insert(schema.reviewReports)
      .values({
        workspaceId,
        repository,
        kind,
        title,
        body,
        ...(pullRequest !== undefined ? { pullRequest } : {}),
      })
      .returning({ id: schema.reviewReports.id });
    const ids: string[] = [];
    for (const f of findings) {
      const [row] = await db
        .insert(schema.reviewFindings)
        .values({
          workspaceId,
          repository,
          reportId: report!.id,
          kind: findingKey(f),
          evidence: f.evidence,
          title: f.title,
          body: f.body,
          path: f.path ?? null,
          line: f.line ?? null,
          service: f.service ?? null,
          route: f.route ?? null,
        })
        .returning({ id: schema.reviewFindings.id });
      ids.push(row!.id);
    }
    return { reportId: report!.id, findingIds: ids };
  }

  const evidenceLine = (f: Finding) =>
    `<sub>Based on ${f.evidence.metric}, ${/^\d/.test(f.evidence.window) ? `the last ${f.evidence.window}` : f.evidence.window}.</sub>`;

  /** Post findings on a pull request: on the line when the diff has it, else on the pull request. */
  async function post(
    repo: Repo,
    repository: string,
    number: number,
    commit: string,
    reportId: string,
    findings: Finding[],
    ids: string[],
    changedLines: Map<string, Set<number>>,
  ) {
    for (const [i, f] of findings.entries()) {
      const link = `${options.webUrl}/review/${reportId}#f-${ids[i]}`;
      const body = `**${f.title}**\n\n${f.body}\n\n${evidenceLine(f)}\n<sub>[Details](${link}) · Not useful? Dismiss it there and I will stop leaving this kind of comment here.</sub>`;
      const onLine = f.path && f.line && changedLines.get(f.path)?.has(f.line);
      const posted = onLine
        ? await repo.lineComment(repository, number, {
            body,
            commit_id: commit,
            path: f.path!,
            line: f.line!,
          })
        : await repo.comment(repository, number, body);
      await db
        .update(schema.reviewFindings)
        .set({ externalRef: { id: posted.id, url: posted.html_url } })
        .where(eq(schema.reviewFindings.id, ids[i]!));
    }
  }

  return {
    indexAt,

    /** R3 and R4 for one pull request. */
    async reviewPull(installationId: string, repository: string, number: number) {
      const workspaceId = await workspaceForInstallation(db, installationId);
      if (!workspaceId) return undefined;
      const repo = options.github.forInstallation(installationId);
      const pull = await repo.pull(repository, number);
      const files = await repo.pullFiles(repository, number);
      const index = await indexAt(workspaceId, repo, repository, pull.head.sha);
      const all = [
        ...conventionFindings(index, files),
        ...(await touchedEndpointFindings({
          index,
          files,
          query: queryFor(workspaceId),
          window: options.window,
        })),
      ];
      const skip = await suppressed(workspaceId, repository);
      const findings = all.filter((f) => !skip.has(findingKey(f)));
      const { reportId, findingIds } = await save(
        workspaceId,
        repository,
        'pull_request',
        `${repository}#${number}: ${pull.title}`,
        findings,
        { suppressed: all.length - findings.length, head: pull.head.sha },
        number,
      );
      const { parsePatch } = await import('./diff.js');
      const changed = new Map(
        files.map((f) => [f.filename, new Set(parsePatch(f.patch).added.map((a) => a.line))]),
      );
      await post(repo, repository, number, pull.head.sha, reportId, findings, findingIds, changed);
      return { reportId, findings: findings.length, suppressed: all.length - findings.length };
    },

    /** R5: compare the pull requests in a deploy, before and after. */
    async followUpDeploy(
      installationId: string,
      repository: string,
      sha: string,
      deployedAt: number,
    ) {
      const workspaceId = await workspaceForInstallation(db, installationId);
      if (!workspaceId) return [];
      const repo = options.github.forInstallation(installationId);
      const pulls = await repo.pullsForCommit(repository, sha);
      const index = await indexAt(workspaceId, repo, repository, sha);
      const results = [];
      for (const pull of pulls) {
        const files = await repo.pullFiles(repository, pull.number);
        const findings = await deployFindings({
          index,
          files,
          query: queryFor(workspaceId),
          deployedAt,
          window: options.deployWindow,
        });
        if (findings.length === 0) continue;
        const { reportId, findingIds } = await save(
          workspaceId,
          repository,
          'deploy',
          `After deploying ${sha.slice(0, 7)}: ${repository}#${pull.number}`,
          findings,
          { sha, deployedAt },
          pull.number,
        );
        await post(repo, repository, pull.number, sha, reportId, findings, findingIds, new Map());
        await options.notify?.(
          workspaceId,
          `After the deploy of ${repository}#${pull.number}: ${findings.map((f) => f.title.replace(/^After the deploy, /, '')).join('; ')}. ${options.webUrl}/review/${reportId}`,
        );
        results.push({ pull: pull.number, reportId, findings: findings.length });
      }
      return results;
    },

    /** R2 (bottlenecks) or R8 (architecture) for every repository of a workspace. */
    async report(workspaceId: string, kind: 'bottleneck' | 'architecture') {
      const installations = await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.workspaceId, workspaceId));
      const made: { repository: string; reportId: string; findings: number }[] = [];
      for (const installation of installations) {
        const repo = options.github.forInstallation(installation.installationId);
        for (const { full_name: repository, default_branch: branch } of await repo.repositories()) {
          const head = await repo.branchHead(repository, branch);
          const index = await indexAt(workspaceId, repo, repository, head);
          if (index.manifests.length === 0) continue;
          const query = queryFor(workspaceId);
          if (kind === 'bottleneck') {
            const { findings, stats } = await bottleneckReport({
              index,
              query,
              window: options.window,
            });
            const { reportId } = await save(
              workspaceId,
              repository,
              'bottleneck',
              `Bottlenecks in ${repository}`,
              findings,
              { endpoints: stats.length, commit: head },
            );
            made.push({ repository, reportId, findings: findings.length });
          } else {
            const { map, findings } = await architectureReview({
              index,
              query,
              window: options.window,
            });
            const memory = createMemory(db, workspaceId);
            for (const edge of map.edges) {
              await memory.replace(
                {
                  kind: 'service_map',
                  subject: `${edge.from} → ${edge.to}`,
                  text: `${edge.from} calls ${edge.to} (${edge.address}), ${edge.rate.toFixed(2)} calls per second over ${options.window}.`,
                  source: `architecture review of ${repository}`,
                  value: edge,
                },
                { kind: 'agent', id: 'review' },
              );
            }
            const { reportId } = await save(
              workspaceId,
              repository,
              'architecture',
              `Architecture of ${repository}`,
              findings,
              { map, commit: head },
            );
            made.push({ repository, reportId, findings: findings.length });
          }
        }
      }
      return made;
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;

/** R6: record that someone dismissed a finding; after that, its kind is not posted again on that repository. */
export async function recordDecision(
  db: Database,
  workspaceId: string,
  findingId: string,
  userId: string,
  decision: 'accepted' | 'dismissed',
) {
  const [finding] = await db
    .update(schema.reviewFindings)
    .set({ status: decision, decidedBy: userId, decidedAt: new Date() })
    .where(
      and(
        eq(schema.reviewFindings.id, findingId),
        eq(schema.reviewFindings.workspaceId, workspaceId),
      ),
    )
    .returning();
  if (!finding || decision !== 'dismissed') return finding;
  const memory = createMemory(db, workspaceId);
  const subject = `${finding.repository}#${finding.kind}`;
  const previous = (await memory.list({ kind: 'review_feedback', subjects: [subject] }))[0];
  const dismissals = ((previous?.value as { dismissals?: number } | null)?.dismissals ?? 0) + 1;
  await memory.replace(
    {
      kind: 'review_feedback',
      subject,
      text: `Comment type “${finding.kind.replace('convention:', 'convention, ')}” dismissed ${dismissals} time${dismissals === 1 ? '' : 's'} on ${finding.repository}. Not posted there again.`,
      source: `review finding ${finding.id}`,
      value: { dismissals, kind: finding.kind as FindingKind | string },
    },
    { kind: 'user', id: userId },
  );
  return finding;
}
