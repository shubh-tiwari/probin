/** @jsxRuntime automatic @jsxImportSource hono/jsx */
import type { MemoryEntry } from '@app/memory';
import { Layout, TopBar } from './layout.js';

const KIND_LABELS: Record<string, string> = {
  user_default: 'Saved answer',
  team_decision: 'Team decision',
  incident: 'Incident',
  service_map: 'Service map',
  review_feedback: 'Review feedback',
};

/**
 * Everything the agent remembers about this workspace. Anyone in the
 * workspace can edit or delete an entry, or add a team decision.
 */
export function MemoryPage(props: {
  userName: string;
  entries: MemoryEntry[];
  names: Record<string, string>;
  notice?: string;
}) {
  return (
    <Layout title="Memory">
      <TopBar title="Memory" current="memory" userName={props.userName} />
      <main class="page">
        <p style="margin:0;color:var(--secondary)">
          What the assistant remembers about this workspace. Only entries relevant to a request are
          used. Anyone here can change or delete them.
        </p>
        {props.notice ? (
          <p class="notice" role="status">
            {props.notice}
          </p>
        ) : null}
        <section class="panel" aria-labelledby="add-title">
          <h2 id="add-title">Add a team decision</h2>
          <form method="post" action="/memory" class="field">
            <label for="subject">About</label>
            <input id="subject" name="subject" type="text" placeholder="/reports/export" required />
            <label for="text">Decision</label>
            <input
              id="text"
              name="text"
              type="text"
              placeholder="This endpoint is allowed to be slow"
              required
            />
            <div class="choices">
              <button class="btn primary" type="submit">
                Add
              </button>
            </div>
          </form>
        </section>
        {props.entries.length === 0 ? (
          <p class="empty">Nothing remembered yet.</p>
        ) : (
          <table>
            <caption class="visually-hidden">Memory entries</caption>
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">About</th>
                <th scope="col">What</th>
                <th scope="col">From</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {props.entries.map((entry) => (
                <tr>
                  <td>{KIND_LABELS[entry.kind] ?? entry.kind}</td>
                  <td style="overflow-wrap:anywhere">
                    {describeSubject(entry.subject, props.names)}
                  </td>
                  <td>
                    <form
                      method="post"
                      action={`/memory/${entry.id}`}
                      style="display:flex;gap:8px;flex-wrap:wrap"
                    >
                      <label class="visually-hidden" for={`m-${entry.id}`}>
                        Text of this entry
                      </label>
                      <input
                        id={`m-${entry.id}`}
                        name="text"
                        type="text"
                        value={entry.text}
                        style="flex:1;min-width:12rem"
                      />
                      <button class="btn" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                  <td>
                    {entry.createdBy.kind === 'user'
                      ? (props.names[entry.createdBy.id] ?? 'A person')
                      : 'The assistant'}
                    <br />
                    <span class="status">{entry.source}</span>
                  </td>
                  <td>
                    <form method="post" action={`/memory/${entry.id}/delete`}>
                      <button class="btn" type="submit" aria-label={`Delete: ${entry.text}`}>
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </Layout>
  );
}

/** "user:<id>:percentile" reads as "Alice: percentile". */
function describeSubject(subject: string, names: Record<string, string>): string {
  const match = /^user:([^:]+):(.+)$/.exec(subject);
  if (!match) return subject;
  return `${names[match[1]!] ?? 'A person'}: ${match[2]!.replace(/_/g, ' ')}`;
}
